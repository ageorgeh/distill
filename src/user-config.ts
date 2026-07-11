import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { PersistedConfig } from "./config";

export function resolveConfigBaseDir(env: NodeJS.ProcessEnv): string {
  const explicitDir = env.DISTILL_CONFIG_DIR?.trim();

  if (explicitDir) {
    return explicitDir;
  }

  const packageRoot = env.DISTILL_PACKAGE_ROOT?.trim();

  if (packageRoot) {
    return packageRoot;
  }

  return process.cwd();
}

export function resolveConfigPath(env: NodeJS.ProcessEnv): string {
  const explicit = env.DISTILL_CONFIG_PATH?.trim();

  if (explicit) {
    return explicit;
  }

  return path.join(resolveConfigBaseDir(env), "distill.config.ts");
}

export async function readPersistedConfig(
  env: NodeJS.ProcessEnv
): Promise<PersistedConfig> {
  const configPath = resolveConfigPath(env);

  try {
    const moduleUrl = `${pathToFileURL(configPath).href}?distill=${Date.now()}`;
    const parsed = (await import(moduleUrl)).default as PersistedConfig;

    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" ||
        (error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") {
      return {};
    }

    throw error;
  }
}

export async function writePersistedConfig(
  env: NodeJS.ProcessEnv,
  config: PersistedConfig
): Promise<void> {
  const configPath = resolveConfigPath(env);
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    [
      'import type { PersistedConfig } from "./src/config";',
      "",
      `export default ${JSON.stringify(config, null, 2)} satisfies PersistedConfig;`,
      "",
    ].join("\n"),
  );
}
