import path from "node:path";
import { pathToFileURL } from "node:url";

import type { DistillConfig } from "./config";

export function resolveConfigBaseDir(): string {
  return process.cwd();
}

export function resolveConfigPath(cwd = process.cwd()): string {
  return path.join(cwd, "distill.config.ts");
}

export async function readPersistedConfig(
  cwd = process.cwd(),
): Promise<DistillConfig> {
  const configPath = resolveConfigPath(cwd);

  try {
    const moduleUrl = `${pathToFileURL(configPath).href}?distill=${Date.now()}`;
    const parsed = (await import(moduleUrl)).default as DistillConfig;

    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    return parsed;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "ENOENT" || code === "ERR_MODULE_NOT_FOUND") {
      return {};
    }

    throw error;
  }
}
