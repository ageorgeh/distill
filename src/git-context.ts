import { spawn } from "node:child_process";
import path from "node:path";
import type { ContextGatherRequest } from "./config";

const GIT_TIMEOUT_MS = 15_000;
const REMOTE_GIT_TIMEOUT_MS = 30_000;
const GIT_DIAGNOSTIC_BYTE_LIMIT = 16_000;
const GIT_DIFF_BYTE_LIMIT = 60_000;
const GIT_PATCH_PATH_LIMIT = 24;

export interface GitContextResult {
  references: string[];
  changes: GitChange[];
  text: string;
  commands: string[][];
  truncated: boolean;
  patchReferences: string[];
  baseResolution?: GitBaseResolution;
}

export interface GitBaseResolution {
  requestedRef: string;
  localCommit: string;
  resolvedCommit: string;
  source: "local" | "remote-verified" | "local-fallback";
  remote?: string;
  remoteBranch?: string;
  advertisedCommit?: string;
  localWasStale?: boolean;
  fallbackReason?: string;
}

export type GitChangeSource = "committed" | "working-tree" | "untracked";

export interface GitChange {
  path: string;
  additions: number;
  deletions: number;
  sources: GitChangeSource[];
}

export interface GitContextProvider {
  gather(request: ContextGatherRequest, options?: { signal?: AbortSignal }): Promise<GitContextResult>;
}

function appendTail(current: string, chunk: unknown, limit: number): string {
  const combined = current + String(chunk);
  return Buffer.byteLength(combined) <= limit ? combined : Buffer.from(combined).subarray(-limit).toString("utf8");
}

function runGit(root: string, args: string[], signal: AbortSignal | undefined, spawnImpl: typeof spawn, timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const command = ["git", ...args];
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      error ? reject(error) : resolve(stdout);
    };
    const onAbort = () => { child?.kill(); finish(new Error("Deterministic Git context gathering was cancelled.")); };
    if (signal?.aborted) { finish(new Error("Deterministic Git context gathering was cancelled.")); return; }
    try {
      child = spawnImpl("git", args, { cwd: root, shell: false, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    } catch (error) { finish(error as Error); return; }
    timer = setTimeout(() => { child.kill(); finish(new Error(`Git context command timed out after ${timeoutMs}ms: ${command.join(" ")}`)); }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout!.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk) => { stderr = appendTail(stderr, chunk, GIT_DIAGNOSTIC_BYTE_LIMIT); });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => code === 0
      ? finish()
      : finish(new Error(`Git context command exited with code ${code ?? "unknown"}: ${command.join(" ")}\n${stderr.trim() || "no diagnostic output"}`)));
  });
}

function repositoryPaths(root: string, nulSeparated: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of nulSeparated.split("\0").filter(Boolean)) {
    const relative = path.relative(root, path.resolve(root, candidate));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const normalized = relative.split(path.sep).join("/");
    if (!seen.has(normalized)) { seen.add(normalized); result.push(normalized); }
  }
  return result;
}

function numstat(output: string): Map<string, { additions: number; deletions: number }> {
  const result = new Map<string, { additions: number; deletions: number }>();
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const [rawAdditions, rawDeletions, ...pathParts] = line.split("\t");
    const file = pathParts.join("\t");
    if (!file) continue;
    result.set(file, {
      additions: /^\d+$/.test(rawAdditions ?? "") ? Number(rawAdditions) : 0,
      deletions: /^\d+$/.test(rawDeletions ?? "") ? Number(rawDeletions) : 0,
    });
  }
  return result;
}

function mergeChanges(parts: Array<{ paths: string[]; stats?: Map<string, { additions: number; deletions: number }>; source: GitChangeSource }>): GitChange[] {
  const changes = new Map<string, GitChange>();
  for (const part of parts) {
    for (const file of part.paths) {
      const existing = changes.get(file) ?? { path: file, additions: 0, deletions: 0, sources: [] };
      const stats = part.stats?.get(file);
      existing.additions += stats?.additions ?? 0;
      existing.deletions += stats?.deletions ?? 0;
      if (!existing.sources.includes(part.source)) existing.sources.push(part.source);
      changes.set(file, existing);
    }
  }
  return [...changes.values()];
}

function boundedDiff(diff: string): { text: string; truncated: boolean } {
  const buffer = Buffer.from(diff);
  if (buffer.length <= GIT_DIFF_BYTE_LIMIT) return { text: diff, truncated: false };
  const marker = "\n\n[Git diff middle omitted to honor the deterministic-evidence budget]\n\n";
  const available = GIT_DIFF_BYTE_LIMIT - Buffer.byteLength(marker);
  const headBytes = Math.floor(available * 0.7);
  return {
    text: `${buffer.subarray(0, headBytes).toString("utf8")}${marker}${buffer.subarray(buffer.length - (available - headBytes)).toString("utf8")}`,
    truncated: true,
  };
}

const PATCH_TOKEN_STOP_WORDS = new Set(["and", "the", "for", "from", "with", "this", "that", "change", "changes", "review", "implementation", "task", "packages", "modules", "core", "src", "test", "tests"]);

function patchTokens(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3 && !PATCH_TOKEN_STOP_WORDS.has(token)));
}

function patchCategory(file: string): "implementation" | "contract" | "test" | "other" {
  const lower = file.toLowerCase();
  if (/(^|\/)(test|tests|__tests__)(\/|$)|\.(?:unit|int|integration|comp|e2e|spec|test)\.[^.]+$/.test(lower)) return "test";
  if (/(^|\/)(config|schema|schemas|contracts?|types?)(\/|$)|(?:config|schema|contract|types?)\.[^.]+$/.test(lower)) return "contract";
  if (/(^|\/)(docs?|backlog|generated|snapshots?)(\/|$)|\.(?:md|mdx|txt|snap)$|\.lock$/.test(lower)) return "other";
  return "implementation";
}

function selectPatchReferences(request: ContextGatherRequest, changes: GitChange[]): string[] {
  const tracked = changes.filter((change) => change.sources.some((source) => source !== "untracked"));
  const explicit = new Set((request.references ?? []).map((reference) => reference.trim().replace(/^`|`$/g, "").replace(/:\d+(?:-\d+)?$/, "")));
  const frequency = new Map<string, number>();
  for (const change of tracked) for (const token of patchTokens(change.path)) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  const frequencyLimit = Math.max(2, Math.ceil(tracked.length * 0.2));
  const objective = new Set([...patchTokens(request.objective)].filter((token) => (frequency.get(token) ?? 0) <= frequencyLimit));
  const ranked = tracked.map((change) => {
    const overlap = [...patchTokens(change.path)].filter((token) => objective.has(token)).length;
    const kind = patchCategory(change.path);
    const changedLines = change.additions + change.deletions;
    return {
      change,
      kind,
      overlap,
      score: (explicit.has(change.path) ? 100_000 : 0) + overlap * 1_000 + ({ implementation: 300, contract: 250, test: 200, other: 0 }[kind]) + Math.min(100, Math.floor(Math.log2(changedLines + 1) * 12)),
    };
  }).sort((left, right) => right.score - left.score || left.change.path.localeCompare(right.change.path));
  const selected = new Set<string>();
  const choose = (item: typeof ranked[number] | undefined) => { if (item && selected.size < GIT_PATCH_PATH_LIMIT) selected.add(item.change.path); };
  for (const item of ranked.filter((candidate) => explicit.has(candidate.change.path))) choose(item);
  for (const item of ranked.filter((candidate) => candidate.overlap > 0)) choose(item);
  for (const kind of ["implementation", "contract", "test"] as const) choose(ranked.find((candidate) => candidate.kind === kind));
  for (const item of ranked.filter((candidate) => candidate.kind !== "other")) choose(item);
  return [...selected];
}

function oneLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, GIT_DIAGNOSTIC_BYTE_LIMIT);
}

async function resolveReviewBase(
  requestedRef: string,
  execute: (args: string[], timeoutMs?: number) => Promise<string>,
): Promise<GitBaseResolution> {
  const localCommit = (await execute(["rev-parse", "--verify", "--end-of-options", `${requestedRef}^{commit}`])).trim();
  let symbolic = "";
  try {
    symbolic = (await execute(["rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", requestedRef])).trim();
  } catch {
    return { requestedRef, localCommit, resolvedCommit: localCommit, source: "local" };
  }
  const remoteTracking = symbolic.match(/^refs\/remotes\/([^/]+)\/(.+)$/);
  if (!remoteTracking) return { requestedRef, localCommit, resolvedCommit: localCommit, source: "local" };
  const remote = remoteTracking[1]!;
  const remoteBranch = remoteTracking[2]!;
  const remoteRef = `refs/heads/${remoteBranch}`;
  try {
    const advertised = (await execute(["ls-remote", "--exit-code", "--refs", remote, remoteRef], REMOTE_GIT_TIMEOUT_MS)).trim();
    const advertisedCommit = advertised.match(/^([0-9a-fA-F]{40,64})(?:\s|$)/)?.[1]?.toLowerCase();
    if (!advertisedCommit) throw new Error(`Remote ${remote} did not advertise ${remoteRef}.`);
    const localWasStale = advertisedCommit !== localCommit.toLowerCase();
    if (localWasStale) {
      await execute(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remote, advertisedCommit], REMOTE_GIT_TIMEOUT_MS);
      await execute(["cat-file", "-e", `${advertisedCommit}^{commit}`]);
    }
    return {
      requestedRef,
      localCommit,
      resolvedCommit: advertisedCommit,
      source: "remote-verified",
      remote,
      remoteBranch,
      advertisedCommit,
      localWasStale,
    };
  } catch (error) {
    return {
      requestedRef,
      localCommit,
      resolvedCommit: localCommit,
      source: "local-fallback",
      remote,
      remoteBranch,
      fallbackReason: oneLine(error),
    };
  }
}

export function createGitContextProvider(dependencies: { spawn?: typeof spawn } = {}): GitContextProvider {
  const spawnImpl = dependencies.spawn ?? spawn;
  return {
    async gather(request, options) {
      if (request.intent === "implement" || request.intent === "advise") return { references: [], changes: [], text: "", commands: [], truncated: false, patchReferences: [] };
      const commands: string[][] = [];
      const execute = async (args: string[], timeoutMs?: number) => {
        commands.push(["git", ...args]);
        return runGit(request.workspaceRoot, args, options?.signal, spawnImpl, timeoutMs);
      };
      let label: string;
      let names: string;
      let patch: string;
      let changes: GitChange[];
      let patchReferences: string[] = [];
      let baseResolution: GitBaseResolution | undefined;
      if (request.intent === "merge-review") {
        if (!request.baseRef) throw new Error("Merge-review context requires baseRef or repository context.default_base.");
        baseResolution = await resolveReviewBase(request.baseRef, execute);
        const mergeBase = (await execute(["merge-base", baseResolution.resolvedCommit, "HEAD"])).trim();
        const [committedNames, committedNumstat, workingNames, workingNumstat, untrackedNames] = await Promise.all([
          execute(["diff", "--name-only", "-z", "--diff-filter=ACDMRTUXB", mergeBase, "HEAD", "--"]),
          execute(["diff", "--numstat", "--no-renames", mergeBase, "HEAD", "--"]),
          execute(["diff", "--name-only", "-z", "--diff-filter=ACDMRTUXB", "HEAD", "--"]),
          execute(["diff", "--numstat", "--no-renames", "HEAD", "--"]),
          execute(["ls-files", "--others", "--exclude-standard", "-z", "--"]),
        ]);
        const committedPaths = repositoryPaths(request.workspaceRoot, committedNames);
        const workingPaths = repositoryPaths(request.workspaceRoot, workingNames);
        const untrackedPaths = repositoryPaths(request.workspaceRoot, untrackedNames);
        changes = mergeChanges([
          { paths: committedPaths, stats: numstat(committedNumstat), source: "committed" },
          { paths: workingPaths, stats: numstat(workingNumstat), source: "working-tree" },
          { paths: untrackedPaths, source: "untracked" },
        ]);
        names = [...new Set([...committedPaths, ...workingPaths, ...untrackedPaths])].join("\0");
        patchReferences = selectPatchReferences(request, changes);
        const committedPatchReferences = patchReferences.filter((file) => changes.find((change) => change.path === file)?.sources.includes("committed"));
        const workingPatchReferences = patchReferences.filter((file) => changes.find((change) => change.path === file)?.sources.includes("working-tree"));
        const [committedPatch, workingPatch] = await Promise.all([
          committedPatchReferences.length ? execute(["diff", "--no-ext-diff", "--no-color", "--unified=20", mergeBase, "HEAD", "--", ...committedPatchReferences]) : Promise.resolve(""),
          workingPatchReferences.length ? execute(["diff", "--no-ext-diff", "--no-color", "--unified=20", "HEAD", "--", ...workingPatchReferences]) : Promise.resolve(""),
        ]);
        patch = [
          `PATCH FILES (${patchReferences.length} of ${changes.filter((change) => !change.sources.includes("untracked")).length} tracked changed files)\n${patchReferences.length ? patchReferences.map((file) => `- ${file}`).join("\n") : "[none]"}`,
          `COMMITTED PATCH (${mergeBase}..HEAD)\n${committedPatch || "[no selected committed changes]"}`,
          `WORKING-TREE PATCH (HEAD plus staged and unstaged changes)\n${workingPatch || "[no selected tracked working-tree changes]"}`,
          `UNTRACKED FILES\n${untrackedPaths.length ? untrackedPaths.map((file) => `- ${file}`).join("\n") : "[no untracked files]"}`,
        ].join("\n\n");
        label = [
          "intent: merge-review",
          `base_ref: ${request.baseRef}`,
          `local_base: ${baseResolution.localCommit}`,
          `resolved_base: ${baseResolution.resolvedCommit}`,
          `base_source: ${baseResolution.source}`,
          ...(baseResolution.remote ? [`remote: ${baseResolution.remote}`, `remote_branch: ${baseResolution.remoteBranch}`] : []),
          ...(baseResolution.advertisedCommit ? [`advertised_base: ${baseResolution.advertisedCommit}`, `local_base_was_stale: ${baseResolution.localWasStale ? "yes" : "no"}`] : []),
          ...(baseResolution.fallbackReason ? [`remote_refresh_fallback: ${baseResolution.fallbackReason}`] : []),
          `merge_base: ${mergeBase}`,
        ].join("\n");
      } else {
        [names, patch] = await Promise.all([
          execute(["diff", "--name-only", "-z", "--diff-filter=U", "--"]),
          execute(["diff", "--no-ext-diff", "--no-color", "--unified=20", "--diff-filter=U", "--"]),
        ]);
        const paths = repositoryPaths(request.workspaceRoot, names);
        changes = mergeChanges([{ paths, source: "working-tree" }]);
        patchReferences = paths;
        label = "intent: merge\nsource: unmerged index and working-tree entries";
      }
      const references = repositoryPaths(request.workspaceRoot, names);
      const bounded = boundedDiff(patch);
      return {
        references,
        changes,
        text: `${label}\nmandatory_seed_files:\n${references.length ? references.map((file) => `- ${file}`).join("\n") : "- none"}\n\nGIT PATCH\n${bounded.text || "[no matching changes]"}`,
        commands,
        truncated: bounded.truncated,
        patchReferences,
        ...(baseResolution ? { baseResolution } : {}),
      };
    },
  };
}
