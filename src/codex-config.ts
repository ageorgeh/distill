import { readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_PARENT_TOOL_OUTPUT_LIMIT } from "./config";

export async function resolveToolOutputTokenLimit(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const codexHome = env.CODEX_HOME || (env.HOME ? path.join(env.HOME, ".codex") : undefined);
  if (!codexHome) return DEFAULT_PARENT_TOOL_OUTPUT_LIMIT;
  try {
    const input = await readFile(path.join(codexHome, "config.toml"), "utf8");
    const topLevel = input.split(/^\s*\[/m, 1)[0] ?? "";
    const value = topLevel.match(/^\s*tool_output_token_limit\s*=\s*(\d+)\s*$/m)?.[1];
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : DEFAULT_PARENT_TOOL_OUTPUT_LIMIT;
  } catch { return DEFAULT_PARENT_TOOL_OUTPUT_LIMIT; }
}

export function resultBudget(toolOutputTokenLimit: number): { resultTokenBudget: number; resultByteBudget: number } {
  const resultTokenBudget = Math.floor(toolOutputTokenLimit * 0.8);
  return { resultTokenBudget, resultByteBudget: resultTokenBudget * 4 };
}
