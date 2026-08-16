import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { DEFAULT_PARENT_TOOL_OUTPUT_LIMIT } from "./config";

export interface ResolvedToolOutputLimit {
  limit: number;
  source: "codex-home" | "home-codex" | "default";
  configPath?: string;
}

function topLevelLimit(input: string): number | undefined {
  const topLevel = input.split(/^\s*\[/m, 1)[0] ?? "";
  const match = topLevel.match(/^\s*tool_output_token_limit\s*=\s*(\d+)\s*$/m)?.[1];
  const limit = Number(match);
  return Number.isInteger(limit) && limit > 0 ? limit : undefined;
}

export async function resolveToolOutputTokenLimit(env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<ResolvedToolOutputLimit> {
  const candidates: Array<{ source: "codex-home" | "home-codex"; configPath: string }> = [];
  if (env.CODEX_HOME) candidates.push({ source: "codex-home", configPath: path.join(env.CODEX_HOME, "config.toml") });
  if (env.HOME) candidates.push({ source: "home-codex", configPath: path.join(env.HOME, ".codex", "config.toml") });
  const osPath = path.join(home, ".codex", "config.toml");
  if (!candidates.some((candidate) => candidate.configPath === osPath)) candidates.push({ source: "home-codex", configPath: osPath });
  for (const candidate of candidates) {
    try {
      const limit = topLevelLimit(await readFile(candidate.configPath, "utf8"));
      if (limit) return { limit, source: candidate.source, configPath: candidate.configPath };
    } catch { /* Fall through to the next configured home. */ }
  }
  return { limit: DEFAULT_PARENT_TOOL_OUTPUT_LIMIT, source: "default" };
}

export function resultBudget(resolved: ResolvedToolOutputLimit | number): { resultTokenBudget: number; resultByteBudget: number } {
  const limit = typeof resolved === "number" ? resolved : resolved.limit;
  const resultTokenBudget = Math.floor(limit * 0.8);
  return { resultTokenBudget, resultByteBudget: resultTokenBudget * 4 };
}
