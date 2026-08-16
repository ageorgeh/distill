import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Resolve relative telemetry paths against the Distill installation, not the target repository. */
export function resolveTelemetryDirectory(directory: string, override?: string): string {
  if (override) return override;
  if (path.isAbsolute(directory)) return directory;
  const distillRoot = process.env.DISTILL_TELEMETRY_ROOT ?? process.cwd();
  return path.resolve(distillRoot, directory);
}

export function telemetryId(): string { return randomUUID(); }

export async function writeTelemetry(directory: string, id: string, value: unknown): Promise<void> {
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${new Date().toISOString().replace(/[:.]/g, "-")}-${id}.json`), JSON.stringify(value, null, 2), "utf8");
  } catch { /* Telemetry must never alter the primary result. */ }
}
