import { chmod, copyFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { getCurrentPlatformKey, selectPlatformTargets } from "./platform-targets";

const root = path.resolve(import.meta.dir, "..");
const currentTargetKey = getCurrentPlatformKey();
const selectedTargets = selectPlatformTargets({
  buildAll: process.env.DISTILL_BUILD_ALL === "1"
});

if (selectedTargets.length === 0) {
  throw new Error(`Unsupported sync target for this machine: ${currentTargetKey}.`);
}

for (const target of selectedTargets) {
  const source = path.join(root, target.buildOutputPath);
  const destination = path.join(root, target.packageBinaryPath);
  const tempDestination = `${destination}.tmp`;

  await stat(source);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, tempDestination);

  if (!tempDestination.endsWith(".exe")) {
    await chmod(tempDestination, 0o755);
  }

  await replaceFile(tempDestination, destination);
}

async function replaceFile(source: string, destination: string): Promise<void> {
  const retries = 4;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (
        !isTransientBusyError(error) ||
        attempt === retries
      ) {
        throw error;
      }

      await delay(40 * (attempt + 1));
    }
  }
}

function isTransientBusyError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }

  const code = String((error as { code?: unknown }).code);
  return code === "ETXTBSY" || code === "EBUSY" || code === "EPERM";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
