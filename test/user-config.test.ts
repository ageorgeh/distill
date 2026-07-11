import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  readPersistedConfig,
  resolveConfigPath,
  writePersistedConfig,
} from "../src/user-config";

describe("user config", () => {
  it("writes and imports a typed TypeScript config", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "distill-config-"));
    const configPath = path.join(dir, "distill.config.ts");

    try {
      const expected = {
        provider: "codex" as const,
        model: "qwen3.5:2b",
        codexModel: "gpt-5.3-codex-spark",
        codexCommand: "/opt/codex",
        datasetEnabled: false,
      };
      await writePersistedConfig({ DISTILL_CONFIG_PATH: configPath }, expected);

      expect(await readPersistedConfig({ DISTILL_CONFIG_PATH: configPath })).toEqual(expected);
      const source = await readFile(configPath, "utf8");
      expect(source).toContain('import type { PersistedConfig } from "./src/config";');
      expect(source).toContain("satisfies PersistedConfig");
      expect(source).toContain('"datasetEnabled": false');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves config path from explicit path, explicit dir, package root, and cwd", () => {
    expect(resolveConfigPath({ DISTILL_CONFIG_PATH: "/tmp/custom-distill.ts" }))
      .toBe("/tmp/custom-distill.ts");
    expect(resolveConfigPath({ DISTILL_CONFIG_DIR: "/tmp/custom-distill" }))
      .toBe(path.join("/tmp/custom-distill", "distill.config.ts"));
    expect(resolveConfigPath({ DISTILL_PACKAGE_ROOT: "/tmp/package-root" }))
      .toBe(path.join("/tmp/package-root", "distill.config.ts"));
    expect(resolveConfigPath({})).toBe(path.join(process.cwd(), "distill.config.ts"));
  });
});
