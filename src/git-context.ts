import { spawn } from "node:child_process";
import path from "node:path";
import type { ContextGatherRequest } from "./config";

const GIT_TIMEOUT_MS = 15_000;
const GIT_DIAGNOSTIC_BYTE_LIMIT = 16_000;
const GIT_DIFF_BYTE_LIMIT = 60_000;

export interface GitContextResult {
  references: string[];
  text: string;
  commands: string[][];
  truncated: boolean;
}

export interface GitContextProvider {
  gather(request: ContextGatherRequest, options?: { signal?: AbortSignal }): Promise<GitContextResult>;
}

function appendTail(current: string, chunk: unknown, limit: number): string {
  const combined = current + String(chunk);
  return Buffer.byteLength(combined) <= limit ? combined : Buffer.from(combined).subarray(-limit).toString("utf8");
}

function runGit(root: string, args: string[], signal: AbortSignal | undefined, spawnImpl: typeof spawn): Promise<string> {
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
      child = spawnImpl("git", args, { cwd: root, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) { finish(error as Error); return; }
    timer = setTimeout(() => { child.kill(); finish(new Error(`Git context command timed out after ${GIT_TIMEOUT_MS}ms: ${command.join(" ")}`)); }, GIT_TIMEOUT_MS);
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

export function createGitContextProvider(dependencies: { spawn?: typeof spawn } = {}): GitContextProvider {
  const spawnImpl = dependencies.spawn ?? spawn;
  return {
    async gather(request, options) {
      if (request.intent === "implement" || request.intent === "advise") return { references: [], text: "", commands: [], truncated: false };
      const commands: string[][] = [];
      const execute = async (args: string[]) => {
        commands.push(["git", ...args]);
        return runGit(request.workspaceRoot, args, options?.signal, spawnImpl);
      };
      let label: string;
      let names: string;
      let patch: string;
      if (request.intent === "review") {
        if (!request.baseRef) throw new Error("Review context requires baseRef or repository context.default_base.");
        const resolvedBase = (await execute(["rev-parse", "--verify", "--end-of-options", `${request.baseRef}^{commit}`])).trim();
        const mergeBase = (await execute(["merge-base", resolvedBase, "HEAD"])).trim();
        [names, patch] = await Promise.all([
          execute(["diff", "--name-only", "-z", "--diff-filter=ACDMRTUXB", mergeBase, "HEAD", "--"]),
          execute(["diff", "--no-ext-diff", "--no-color", "--unified=20", mergeBase, "HEAD", "--"]),
        ]);
        label = `intent: review\nbase_ref: ${request.baseRef}\nresolved_base: ${resolvedBase}\nmerge_base: ${mergeBase}`;
      } else {
        [names, patch] = await Promise.all([
          execute(["diff", "--name-only", "-z", "--diff-filter=U", "--"]),
          execute(["diff", "--no-ext-diff", "--no-color", "--unified=20", "--diff-filter=U", "--"]),
        ]);
        label = "intent: merge\nsource: unmerged index and working-tree entries";
      }
      const references = repositoryPaths(request.workspaceRoot, names);
      const bounded = boundedDiff(patch);
      return {
        references,
        text: `${label}\nmandatory_seed_files:\n${references.length ? references.map((file) => `- ${file}`).join("\n") : "- none"}\n\nGIT PATCH\n${bounded.text || "[no matching changes]"}`,
        commands,
        truncated: bounded.truncated,
      };
    },
  };
}
