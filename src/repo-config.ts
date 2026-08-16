import { readFile } from "node:fs/promises";
import path from "node:path";

export interface RepositoryConfig { documentationIndexes: string[]; defaultBase?: string; }

/** Deliberately small TOML reader for the two supported repository settings. */
export async function readRepositoryConfig(workspaceRoot: string): Promise<RepositoryConfig> {
  try {
    const input = await readFile(path.join(workspaceRoot, ".distill", "config.toml"), "utf8");
    const section = input.match(/\[context\]([\s\S]*?)(?:\n\[[^\]]+\]|$)/)?.[1] ?? "";
    const defaultBase = section.match(/^\s*default_base\s*=\s*["']([^"']+)["']\s*$/m)?.[1];
    const list = section.match(/documentation_indexes\s*=\s*\[([\s\S]*?)\]/m)?.[1] ?? "";
    const documentationIndexes = [...list.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]!).filter(Boolean);
    return { documentationIndexes, ...(defaultBase ? { defaultBase } : {}) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { documentationIndexes: [] };
    throw error;
  }
}
