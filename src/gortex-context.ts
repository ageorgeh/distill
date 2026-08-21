import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ContextConfig, ContextGatherRequest } from "./config";

const EXPLICIT_FILE_BYTE_LIMIT = 12_000;
const EXPLICIT_TOTAL_BYTE_LIMIT = 80_000;
const DOCUMENTATION_FILE_BYTE_LIMIT = 20_000;
const DOCUMENTATION_TOTAL_BYTE_LIMIT = 40_000;
const INLINE_EVIDENCE_BYTE_LIMIT = 16_000;
const DIAGNOSTIC_BYTE_LIMIT = 16_000;

export interface GortexContextResult {
  text: string;
  durationMs: number;
  bytes: number;
  rawBytes: number;
  truncated: boolean;
  command: string[];
  supplementedReferences: string[];
  documentationIndexes: string[];
  deterministicEvidenceBytes: number;
}

export interface GortexGatherOptions {
  signal?: AbortSignal;
  documentationIndexes?: string[];
  deterministicEvidence?: string;
}

export interface GortexContextProvider {
  gather(request: ContextGatherRequest, options?: GortexGatherOptions): Promise<GortexContextResult>;
}

interface GortexDependencies {
  spawn: typeof spawn;
  readFile: typeof readFile;
  stat: typeof stat;
}

function retrievalTask(request: ContextGatherRequest): string {
  const evidence = request.inlineEvidence ? Buffer.from(request.inlineEvidence).subarray(0, INLINE_EVIDENCE_BYTE_LIMIT).toString("utf8") : "";
  return [
    request.objective,
    request.references?.length ? `Explicit retrieval references:\n${request.references.map((reference) => `- ${reference}`).join("\n")}` : "",
    evidence ? `Additional supplied evidence:\n${evidence}${Buffer.byteLength(request.inlineEvidence ?? "") > INLINE_EVIDENCE_BYTE_LIMIT ? "\n[additional evidence truncated]" : ""}` : "",
  ].filter(Boolean).join("\n\n");
}

function appendBounded(current: string, chunk: unknown, limit: number): string {
  const combined = current + String(chunk);
  return Buffer.byteLength(combined) <= limit ? combined : Buffer.from(combined).subarray(-limit).toString("utf8");
}

function runGortex(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  spawnImpl: typeof spawn,
): Promise<{ stdout: string; rawBytes: number }> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    let stdout = "";
    let stderr = "";
    let rawBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelled = new Error("Gortex context retrieval was cancelled.");
    let onAbort = () => {};
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      error ? reject(error) : resolve({ stdout, rawBytes });
    };
    onAbort = () => { child?.kill(); finish(cancelled); };
    if (signal?.aborted) { finish(cancelled); return; }
    try {
      child = spawnImpl(executable, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      finish(code === "ENOENT" ? new Error(`Gortex CLI not found: ${executable}.`) : error as Error);
      return;
    }
    timer = setTimeout(() => { child.kill(); finish(new Error(`Gortex explore timed out after ${timeoutMs}ms.`)); }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout!.on("data", (chunk) => { const value = String(chunk); rawBytes += Buffer.byteLength(value); stdout += value; });
    child.stderr!.on("data", (chunk) => { stderr = appendBounded(stderr, chunk, DIAGNOSTIC_BYTE_LIMIT); });
    child.on("error", (error: NodeJS.ErrnoException) => finish(error.code === "ENOENT" ? new Error(`Gortex CLI not found: ${executable}.`) : error));
    child.on("close", (code) => {
      if (code === 0 && stdout.trim()) finish();
      else if (code === 0) finish(new Error("Gortex explore returned no context."));
      else finish(new Error(`Gortex explore exited with code ${code ?? "unknown"}: ${stderr.trim() || "no diagnostic output"}`));
    });
  });
}

function normalizeReference(root: string, reference: string): { relative: string; startLine?: number; endLine?: number } | undefined {
  const trimmed = reference.trim().replace(/^`|`$/g, "");
  const match = trimmed.match(/^(.*?):(\d+)(?:-(\d+))?$/);
  const candidate = match?.[1] ?? trimmed;
  const absolute = path.resolve(root, candidate);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return {
    relative: relative.split(path.sep).join("/"),
    ...(match ? { startLine: Number(match[2]), endLine: Number(match[3] ?? match[2]) } : {}),
  };
}

function numberedSource(source: string, byteLimit: number, requested?: { startLine: number; endLine: number }): string {
  const lines = source.split(/\r?\n/);
  const start = requested ? Math.max(1, requested.startLine - 20) : 1;
  const end = requested ? Math.min(lines.length, requested.endLine + 80) : lines.length;
  const body = lines.slice(start - 1, end).map((line, index) => `${start + index} | ${line}`).join("\n");
  const buffer = Buffer.from(body);
  if (buffer.length <= byteLimit) return body;
  const marker = "\n[exact source excerpt truncated]\n";
  const available = Math.max(0, byteLimit - Buffer.byteLength(marker));
  const headBytes = requested ? available : Math.floor(available * 0.7);
  return `${buffer.subarray(0, headBytes).toString("utf8")}${marker}${requested ? "" : buffer.subarray(buffer.length - (available - headBytes)).toString("utf8")}`;
}

async function explicitSupplements(
  request: ContextGatherRequest,
  deps: Pick<GortexDependencies, "readFile" | "stat">,
): Promise<{ text: string; files: string[] }> {
  const sources: Array<{ relative: string; source: string; requested?: { startLine: number; endLine: number } }> = [];
  const seen = new Set<string>();
  for (const reference of request.references ?? []) {
    const resolved = normalizeReference(request.workspaceRoot, reference);
    if (!resolved || seen.has(resolved.relative)) continue;
    const absolute = path.join(request.workspaceRoot, resolved.relative);
    try {
      if (!(await deps.stat(absolute)).isFile()) continue;
      const source = await deps.readFile(absolute, "utf8");
      sources.push({ relative: resolved.relative, source, ...(resolved.startLine && resolved.endLine ? { requested: { startLine: resolved.startLine, endLine: resolved.endLine } } : {}) });
      seen.add(resolved.relative);
    } catch { /* Non-file references remain useful retrieval terms but need no source supplement. */ }
  }
  const perFileLimit = Math.min(EXPLICIT_FILE_BYTE_LIMIT, Math.max(512, Math.floor(EXPLICIT_TOTAL_BYTE_LIMIT / Math.max(1, sources.length))));
  return {
    text: sources.map((item) => `EXPLICIT REFERENCE SOURCE\nfile: ${item.relative}\n${numberedSource(item.source, perFileLimit, item.requested)}`).join("\n\n"),
    files: sources.map((item) => item.relative),
  };
}

async function documentationSources(
  root: string,
  indexes: string[],
  deps: Pick<GortexDependencies, "readFile" | "stat">,
): Promise<{ text: string; files: string[] }> {
  const sources: Array<{ relative: string; source: string }> = [];
  const seen = new Set<string>();
  for (const index of indexes) {
    const resolved = normalizeReference(root, index);
    if (!resolved || seen.has(resolved.relative)) continue;
    try {
      const absolute = path.join(root, resolved.relative);
      if (!(await deps.stat(absolute)).isFile()) continue;
      sources.push({ relative: resolved.relative, source: await deps.readFile(absolute, "utf8") });
      seen.add(resolved.relative);
    } catch { /* Missing documentation indexes contribute no candidate evidence. */ }
  }
  const perFileLimit = Math.min(DOCUMENTATION_FILE_BYTE_LIMIT, Math.max(512, Math.floor(DOCUMENTATION_TOTAL_BYTE_LIMIT / Math.max(1, sources.length))));
  return {
    text: sources.map((item) => `DOCUMENTATION INDEX SOURCE\nfile: ${item.relative}\n${numberedSource(item.source, perFileLimit)}`).join("\n\n"),
    files: sources.map((item) => item.relative),
  };
}

function boundedText(input: string, limit: number, marker: string): { text: string; truncated: boolean } {
  const buffer = Buffer.from(input);
  if (buffer.length <= limit) return { text: input, truncated: false };
  const separator = `\n\n[${marker}]\n\n`;
  const available = Math.max(0, limit - Buffer.byteLength(separator));
  const headBytes = Math.floor(available * 0.7);
  return { text: `${buffer.subarray(0, headBytes).toString("utf8")}${separator}${buffer.subarray(buffer.length - (available - headBytes)).toString("utf8")}`, truncated: true };
}

function boundedCandidateContext(
  gortexOutput: string,
  supplement: string,
  documentation: string,
  deterministicEvidence: string,
  references: string[],
  limit: number,
): { text: string; truncated: boolean } {
  const header = [
    "GORTEX OVER-GATHER (deterministic graph retrieval; candidate evidence, not conclusions)",
    references.length ? `EXPLICIT REFERENCES (always consider these even if graph ranking omitted them)\n${references.map((reference) => `- ${reference}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  const evidenceInput = [
    supplement ? `EXPLICIT REFERENCE SOURCES\n${supplement}` : "",
    deterministicEvidence ? `DETERMINISTIC GIT EVIDENCE\n${deterministicEvidence}` : "",
    documentation ? `REPOSITORY DOCUMENTATION INDEXES\n${documentation}` : "",
  ].filter(Boolean).join("\n\n");
  const fixedBytes = Buffer.byteLength(header) + Buffer.byteLength("GORTEX TOON OUTPUT") + (evidenceInput ? 6 : 4);
  const allowance = Math.max(0, limit - fixedBytes);
  const graphReserve = Math.min(Buffer.byteLength(gortexOutput), Math.max(40_000, Math.floor(allowance * 0.35)));
  const evidence = boundedText(evidenceInput, Math.max(0, allowance - graphReserve), "deterministic candidate evidence omitted to honor the context budget");
  const graphAllowance = Math.max(0, allowance - Buffer.byteLength(evidence.text));
  const graph = boundedText(gortexOutput, graphAllowance, "Gortex output middle omitted to honor the candidate-context budget");
  const text = [header, evidence.text, "GORTEX TOON OUTPUT", graph.text].filter(Boolean).join("\n\n");
  return { text: Buffer.from(text).subarray(0, limit).toString("utf8"), truncated: evidence.truncated || graph.truncated || Buffer.byteLength(text) > limit };
}

export function createGortexContextProvider(config: ContextConfig, dependencies: Partial<GortexDependencies> = {}): GortexContextProvider {
  const deps: GortexDependencies = { spawn, readFile, stat, ...dependencies };
  return {
    async gather(request, options) {
      const task = retrievalTask(request);
      const args = ["explore", task, "--index", request.workspaceRoot, "--format", "toon", "--max-symbols", String(config.gortexMaxSymbols), "--no-progress"];
      const startedAt = Date.now();
      const result = await runGortex(config.gortexCommand, args, request.workspaceRoot, config.gortexTimeoutMs, options?.signal, deps.spawn);
      const [supplements, documentation] = await Promise.all([
        explicitSupplements(request, deps),
        documentationSources(request.workspaceRoot, options?.documentationIndexes ?? [], deps),
      ]);
      const deterministicEvidence = options?.deterministicEvidence ?? "";
      const bounded = boundedCandidateContext(result.stdout, supplements.text, documentation.text, deterministicEvidence, request.references ?? [], config.gortexMaxOutputBytes);
      return {
        text: bounded.text,
        durationMs: Date.now() - startedAt,
        bytes: Buffer.byteLength(bounded.text),
        rawBytes: result.rawBytes,
        truncated: bounded.truncated,
        command: [config.gortexCommand, ...args],
        supplementedReferences: supplements.files,
        documentationIndexes: documentation.files,
        deterministicEvidenceBytes: Buffer.byteLength(deterministicEvidence),
      };
    },
  };
}
