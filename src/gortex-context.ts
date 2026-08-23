import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ContextConfig, ContextGatherRequest } from "./config";
import type { GitChange } from "./git-context";

const EXPLICIT_FILE_BYTE_LIMIT = 12_000;
const EXPLICIT_TOTAL_BYTE_LIMIT = 80_000;
const DOCUMENTATION_FILE_BYTE_LIMIT = 20_000;
const DOCUMENTATION_TOTAL_BYTE_LIMIT = 40_000;
const INLINE_EVIDENCE_BYTE_LIMIT = 16_000;
const DIAGNOSTIC_BYTE_LIMIT = 16_000;
const GIT_SEED_PATH_LIMIT = 24;
const GIT_SEED_BYTE_LIMIT = 4_096;
const GIT_AREA_DIGEST_LIMIT = 20;

export interface GitSeedDecision {
  path: string;
  selected: boolean;
  category: "implementation" | "test" | "contract" | "documentation" | "generated";
  area: string;
  score: number;
  additions: number;
  deletions: number;
  sources: string[];
  reason: string;
}

export interface GortexAttemptDetails {
  durationMs: number;
  command: string[];
  retrievalTaskBytes: number;
  explicitReferenceCount: number;
  gitReferenceCount: number;
  selectedGitReferences: string[];
  gitSeedDecisions: GitSeedDecision[];
  gitAreaDigest: string;
}

export interface GortexContextResult extends GortexAttemptDetails {
  text: string;
  bytes: number;
  rawBytes: number;
  truncated: boolean;
  supplementedReferences: string[];
  documentationIndexes: string[];
  deterministicEvidenceBytes: number;
}

export interface GortexGatherOptions {
  signal?: AbortSignal;
  documentationIndexes?: string[];
  deterministicEvidence?: string;
  gitChanges?: GitChange[];
}

export interface GortexContextProvider {
  gather(request: ContextGatherRequest, options?: GortexGatherOptions): Promise<GortexContextResult>;
}

interface GortexDependencies {
  spawn: typeof spawn;
  readFile: typeof readFile;
  stat: typeof stat;
}

interface GitSeedSelection {
  selected: string[];
  decisions: GitSeedDecision[];
  areaDigest: string;
}

const TOKEN_STOP_WORDS = new Set(["and", "the", "for", "from", "into", "with", "this", "that", "changes", "change", "review", "implement", "implementation", "file", "files", "task", "packages", "modules", "src", "tests", "test"]);

function tokens(input: string): Set<string> {
  return new Set(input.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3 && !TOKEN_STOP_WORDS.has(token)));
}

function category(file: string): GitSeedDecision["category"] {
  const lower = file.toLowerCase();
  if (/(^|\/)(generated|__snapshots__|snapshots|dist|build|coverage|node_modules|\.svelte-kit)(\/|$)|\.snap$|\.lock$|lock\.ya?ml$|\.tgz$/.test(lower)) return "generated";
  if (/(^|\/)(test|tests|__tests__)(\/|$)|\.(?:unit|int|integration|comp|e2e|spec|test)\.[^.]+$/.test(lower)) return "test";
  if (/(^|\/)(docs?|backlog)(\/|$)|\.(?:md|mdx|txt)$/.test(lower)) return "documentation";
  if (/(^|\/)(config|schema|schemas|contracts?|migrations?|types?)(\/|$)|(?:config|schema|contract|manifest|types?)\.[^.]+$/.test(lower)) return "contract";
  return "implementation";
}

function area(file: string): string {
  const parts = file.split("/");
  if (parts[0] === "packages" && parts.length >= 4) return parts.slice(0, 4).join("/");
  return parts.slice(0, Math.min(2, Math.max(1, parts.length - 1))).join("/");
}

function pathWithoutRange(reference: string): string {
  return reference.trim().replace(/^`|`$/g, "").replace(/:\d+(?:-\d+)?$/, "");
}

function selectGitSeeds(request: ContextGatherRequest, changes: GitChange[]): GitSeedSelection {
  const explicit = new Set((request.references ?? []).map(pathWithoutRange));
  const queryTokens = tokens([request.objective, ...(request.references ?? [])].join(" "));
  const ranked: Array<GitSeedDecision & { overlap: number }> = changes.map((change) => {
    const pathTokens = tokens(change.path);
    const overlap = [...pathTokens].filter((token) => queryTokens.has(token)).length;
    const kind = category(change.path);
    const base = { implementation: 500, contract: 450, test: 350, documentation: 180, generated: 40 }[kind];
    const changedLines = change.additions + change.deletions;
    const magnitude = Math.min(80, Math.floor(Math.log2(changedLines + 1) * 12));
    const working = change.sources.includes("working-tree") ? 30 : change.sources.includes("untracked") ? 20 : 0;
    return {
      path: change.path,
      selected: false,
      category: kind,
      area: area(change.path),
      score: base + (overlap * 120) + magnitude + working,
      additions: change.additions,
      deletions: change.deletions,
      sources: change.sources,
      reason: explicit.has(change.path) ? "already supplied as an explicit reference" : "lower-ranked within the graph-seed budget",
      overlap,
    };
  }).sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));

  const selected = new Set<string>();
  let selectedBytes = 0;
  const choose = (decision: typeof ranked[number] | undefined, reason: string) => {
    if (!decision || explicit.has(decision.path) || selected.has(decision.path) || selected.size >= GIT_SEED_PATH_LIMIT) return;
    const bytes = Buffer.byteLength(`- ${decision.path}\n`);
    if (selectedBytes + bytes > GIT_SEED_BYTE_LIMIT) { decision.reason = "omitted because the graph-seed byte budget was exhausted"; return; }
    decision.selected = true;
    decision.reason = reason;
    selected.add(decision.path);
    selectedBytes += bytes;
  };

  for (const kind of ["implementation", "contract", "test", "documentation"] as const) {
    choose(ranked.find((item) => item.category === kind && !explicit.has(item.path)), `highest-ranked ${kind} change`);
  }
  const useful = ranked.filter((item) => item.category !== "generated" || item.overlap > 0);
  const areas = [...new Set(useful.filter((item) => !explicit.has(item.path)).map((item) => item.area))]
    .sort((left, right) => {
      const leftScore = ranked.find((item) => item.area === left)?.score ?? 0;
      const rightScore = ranked.find((item) => item.area === right)?.score ?? 0;
      return rightScore - leftScore || left.localeCompare(right);
    });
  for (const changedArea of areas) choose(useful.find((item) => item.area === changedArea && !selected.has(item.path)), `representative for changed area ${changedArea}`);
  for (const decision of useful) choose(decision, decision.overlap ? `high-ranked change with ${decision.overlap} objective/path token match${decision.overlap === 1 ? "" : "es"}` : "highest remaining changed-file score");
  for (const decision of ranked) {
    if (!decision.selected && decision.category === "generated" && decision.overlap === 0) decision.reason = "generated or snapshot-like path without objective overlap";
  }

  const areaCounts = new Map<string, number>();
  for (const change of changes) areaCounts.set(area(change.path), (areaCounts.get(area(change.path)) ?? 0) + 1);
  const sortedAreas = [...areaCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const visibleAreas = sortedAreas.slice(0, GIT_AREA_DIGEST_LIMIT);
  const remaining = sortedAreas.slice(GIT_AREA_DIGEST_LIMIT).reduce((total, item) => total + item[1], 0);
  const areaDigest = [...visibleAreas.map(([name, count]) => `- ${name}: ${count} file${count === 1 ? "" : "s"}`), ...(remaining ? [`- ${remaining} files across ${sortedAreas.length - visibleAreas.length} additional areas`] : [])].join("\n");
  return { selected: [...selected], decisions: ranked.map(({ overlap: _overlap, ...decision }) => decision), areaDigest };
}

function retrievalTask(request: ContextGatherRequest, selection: GitSeedSelection): string {
  const evidence = request.inlineEvidence ? Buffer.from(request.inlineEvidence).subarray(0, INLINE_EVIDENCE_BYTE_LIMIT).toString("utf8") : "";
  return [
    request.objective,
    request.references?.length ? `Explicit retrieval references:\n${request.references.map((reference) => `- ${reference}`).join("\n")}` : "",
    selection.selected.length ? `Representative changed-file graph seeds:\n${selection.selected.map((reference) => `- ${reference}`).join("\n")}` : "",
    selection.areaDigest ? `Changed-area digest (complete change locations are supplied separately as deterministic evidence):\n${selection.areaDigest}` : "",
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
    const interrupt = () => {
      if (!child || child.exitCode !== null) return;
      child.kill("SIGINT");
      const force = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1_000);
      force.unref();
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      error ? reject(error) : resolve({ stdout, rawBytes });
    };
    onAbort = () => { interrupt(); finish(cancelled); };
    if (signal?.aborted) { finish(cancelled); return; }
    try {
      child = spawnImpl(executable, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      finish(code === "ENOENT" ? new Error(`Gortex CLI not found: ${executable}.`) : error as Error);
      return;
    }
    timer = setTimeout(() => { interrupt(); finish(new Error(`Gortex explore timed out after ${timeoutMs}ms; the CLI was interrupted, but Gortex may continue daemon-side work if cancellation is not propagated.`)); }, timeoutMs);
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
  root: string,
  references: string[],
  deps: Pick<GortexDependencies, "readFile" | "stat">,
): Promise<{ text: string; files: string[] }> {
  const sources: Array<{ relative: string; source: string; requested?: { startLine: number; endLine: number } }> = [];
  const seen = new Set<string>();
  for (const reference of references) {
    const resolved = normalizeReference(root, reference);
    if (!resolved || seen.has(resolved.relative)) continue;
    const absolute = path.join(root, resolved.relative);
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
  selectedGitReferences: string[],
  gitAreaDigest: string,
  limit: number,
): { text: string; truncated: boolean } {
  const header = [
    "GORTEX OVER-GATHER (deterministic graph retrieval; candidate evidence, not conclusions)",
    references.length ? `EXPLICIT REFERENCES (always consider these even if graph ranking omitted them)\n${references.map((reference) => `- ${reference}`).join("\n")}` : "",
    selectedGitReferences.length ? `REPRESENTATIVE GIT GRAPH SEEDS (the complete changed-file list remains in deterministic evidence)\n${selectedGitReferences.map((reference) => `- ${reference}`).join("\n")}` : "",
    gitAreaDigest ? `CHANGED-AREA DIGEST\n${gitAreaDigest}` : "",
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

class GortexGatherError extends Error {
  constructor(message: string, readonly attempt: GortexAttemptDetails) { super(message); this.name = "GortexGatherError"; }
}

export function gortexAttemptFromError(error: unknown): GortexAttemptDetails | undefined {
  return error instanceof GortexGatherError ? error.attempt : undefined;
}

export function createGortexContextProvider(config: ContextConfig, dependencies: Partial<GortexDependencies> = {}): GortexContextProvider {
  const deps: GortexDependencies = { spawn, readFile, stat, ...dependencies };
  return {
    async gather(request, options) {
      const selection = selectGitSeeds(request, options?.gitChanges ?? []);
      const task = retrievalTask(request, selection);
      const args = ["explore", task, "--index", request.workspaceRoot, "--format", "toon", "--max-symbols", String(config.gortexMaxSymbols), "--no-progress"];
      const command = [config.gortexCommand, ...args];
      const startedAt = Date.now();
      let result: Awaited<ReturnType<typeof runGortex>>;
      try {
        result = await runGortex(config.gortexCommand, args, request.workspaceRoot, config.gortexTimeoutMs, options?.signal, deps.spawn);
      } catch (error) {
        throw new GortexGatherError(error instanceof Error ? error.message : String(error), {
          durationMs: Date.now() - startedAt,
          command,
          retrievalTaskBytes: Buffer.byteLength(task),
          explicitReferenceCount: request.references?.length ?? 0,
          gitReferenceCount: options?.gitChanges?.length ?? 0,
          selectedGitReferences: selection.selected,
          gitSeedDecisions: selection.decisions,
          gitAreaDigest: selection.areaDigest,
        });
      }
      const supplementReferences = [...new Set([...(request.references ?? []), ...selection.selected])];
      const [supplements, documentation] = await Promise.all([
        explicitSupplements(request.workspaceRoot, supplementReferences, deps),
        documentationSources(request.workspaceRoot, options?.documentationIndexes ?? [], deps),
      ]);
      const deterministicEvidence = options?.deterministicEvidence ?? "";
      const bounded = boundedCandidateContext(result.stdout, supplements.text, documentation.text, deterministicEvidence, request.references ?? [], selection.selected, selection.areaDigest, config.gortexMaxOutputBytes);
      return {
        text: bounded.text,
        durationMs: Date.now() - startedAt,
        bytes: Buffer.byteLength(bounded.text),
        rawBytes: result.rawBytes,
        truncated: bounded.truncated,
        command,
        retrievalTaskBytes: Buffer.byteLength(task),
        explicitReferenceCount: request.references?.length ?? 0,
        gitReferenceCount: options?.gitChanges?.length ?? 0,
        selectedGitReferences: selection.selected,
        gitSeedDecisions: selection.decisions,
        gitAreaDigest: selection.areaDigest,
        supplementedReferences: supplements.files,
        documentationIndexes: documentation.files,
        deterministicEvidenceBytes: Buffer.byteLength(deterministicEvidence),
      };
    },
  };
}
