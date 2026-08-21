import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ContextConfig, ContextGatherRequest } from "./config";

const EXPLICIT_FILE_BYTE_LIMIT = 32_000;
const DIAGNOSTIC_BYTE_LIMIT = 16_000;

export interface GortexContextResult {
  text: string;
  durationMs: number;
  bytes: number;
  rawBytes: number;
  truncated: boolean;
  command: string[];
  supplementedReferences: string[];
}

export interface GortexContextProvider {
  gather(request: ContextGatherRequest, options?: { signal?: AbortSignal }): Promise<GortexContextResult>;
}

interface GortexDependencies {
  spawn: typeof spawn;
  readFile: typeof readFile;
  stat: typeof stat;
}

function retrievalTask(request: ContextGatherRequest): string {
  if (!request.references?.length) return request.objective;
  return `${request.objective}\n\nExplicit retrieval references:\n${request.references.map((reference) => `- ${reference}`).join("\n")}`;
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

function structuredFilePresent(output: string, rootLabel: string, relative: string): boolean {
  const paths = [relative, `${rootLabel}/${relative}`];
  return paths.some((candidate) => output.includes(`file_path: ${candidate}`));
}

function numberedSource(source: string, requested?: { startLine: number; endLine: number }): string {
  const lines = source.split(/\r?\n/);
  const start = requested ? Math.max(1, requested.startLine - 20) : 1;
  const end = requested ? Math.min(lines.length, requested.endLine + 80) : lines.length;
  const body = lines.slice(start - 1, end).map((line, index) => `${start + index} | ${line}`).join("\n");
  const bounded = Buffer.from(body).subarray(0, EXPLICIT_FILE_BYTE_LIMIT).toString("utf8");
  return `${bounded}${Buffer.byteLength(body) > EXPLICIT_FILE_BYTE_LIMIT ? "\n[explicit source truncated]" : ""}`;
}

async function explicitSupplements(
  request: ContextGatherRequest,
  gortexOutput: string,
  deps: Pick<GortexDependencies, "readFile" | "stat">,
): Promise<{ text: string; files: string[] }> {
  const parts: string[] = [];
  const files: string[] = [];
  const seen = new Set<string>();
  const rootLabel = path.basename(request.workspaceRoot);
  for (const reference of request.references ?? []) {
    const resolved = normalizeReference(request.workspaceRoot, reference);
    if (!resolved || seen.has(resolved.relative) || structuredFilePresent(gortexOutput, rootLabel, resolved.relative)) continue;
    const absolute = path.join(request.workspaceRoot, resolved.relative);
    try {
      if (!(await deps.stat(absolute)).isFile()) continue;
      const source = await deps.readFile(absolute, "utf8");
      parts.push(`EXPLICIT REFERENCE SOURCE\nfile: ${resolved.relative}\n${numberedSource(source, resolved.startLine && resolved.endLine ? { startLine: resolved.startLine, endLine: resolved.endLine } : undefined)}`);
      files.push(resolved.relative);
      seen.add(resolved.relative);
    } catch { /* Non-file references remain useful retrieval terms but need no source supplement. */ }
  }
  return { text: parts.join("\n\n"), files };
}

function boundedCandidateContext(gortexOutput: string, supplement: string, references: string[], limit: number): { text: string; truncated: boolean } {
  const header = [
    "GORTEX OVER-GATHER (deterministic graph retrieval; candidate evidence, not conclusions)",
    references.length ? `EXPLICIT REFERENCES (always consider these even if graph ranking omitted them)\n${references.map((reference) => `- ${reference}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  const sourceHeader = supplement ? "\n\nEXPLICIT REFERENCE SUPPLEMENTS\n" : "";
  const graphHeader = "\n\nGORTEX TOON OUTPUT\n";
  const fixedBytes = Buffer.byteLength(header) + Buffer.byteLength(sourceHeader) + Buffer.byteLength(graphHeader);
  const allowance = Math.max(0, limit - fixedBytes);
  const supplementBuffer = Buffer.from(supplement);
  const supplementAllowance = Math.min(supplementBuffer.length, Math.floor(allowance * 0.45));
  const boundedSupplement = supplementBuffer.subarray(0, supplementAllowance).toString("utf8");
  const supplementTruncated = supplementBuffer.length > supplementAllowance;
  const graphAllowance = allowance - Buffer.byteLength(boundedSupplement);
  if (Buffer.byteLength(gortexOutput) <= graphAllowance) {
    const text = `${header}${sourceHeader}${boundedSupplement}${graphHeader}${gortexOutput}`;
    return { text: Buffer.from(text).subarray(0, limit).toString("utf8"), truncated: supplementTruncated };
  }
  const marker = "\n\n[Gortex output middle omitted to honor the candidate-context budget]\n\n";
  const available = Math.max(0, graphAllowance - Buffer.byteLength(marker));
  const headBytes = Math.floor(available * 0.7);
  const buffer = Buffer.from(gortexOutput);
  const selected = `${buffer.subarray(0, headBytes).toString("utf8")}${marker}${buffer.subarray(buffer.length - (available - headBytes)).toString("utf8")}`;
  const text = `${header}${sourceHeader}${boundedSupplement}${graphHeader}${selected}`;
  return { text: Buffer.from(text).subarray(0, limit).toString("utf8"), truncated: true };
}

export function createGortexContextProvider(config: ContextConfig, dependencies: Partial<GortexDependencies> = {}): GortexContextProvider {
  const deps: GortexDependencies = { spawn, readFile, stat, ...dependencies };
  return {
    async gather(request, options) {
      const task = retrievalTask(request);
      const args = ["explore", task, "--index", request.workspaceRoot, "--format", "toon", "--max-symbols", String(config.gortexMaxSymbols), "--no-progress"];
      const startedAt = Date.now();
      const result = await runGortex(config.gortexCommand, args, request.workspaceRoot, config.gortexTimeoutMs, options?.signal, deps.spawn);
      const supplements = await explicitSupplements(request, result.stdout, deps);
      const bounded = boundedCandidateContext(result.stdout, supplements.text, request.references ?? [], config.gortexMaxOutputBytes);
      return {
        text: bounded.text,
        durationMs: Date.now() - startedAt,
        bytes: Buffer.byteLength(bounded.text),
        rawBytes: result.rawBytes,
        truncated: bounded.truncated,
        command: [config.gortexCommand, ...args],
        supplementedReferences: supplements.files,
      };
    },
  };
}
