import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import type { RuntimeConfig } from "../src/config";
import { runOnboarding } from "../src/onboarding";
import { readPersistedConfig } from "../src/user-config";

function captureOutput(): { output: Writable; read: () => string } {
  let text = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    }
  });

  return {
    output,
    read: () => text
  };
}

describe("onboarding", () => {
  it("text onboarding configures Codex without replacing saved Ollama settings", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "distill-onboarding-codex-"));
    const configPath = path.join(dir, "distill.config.ts");
    const { output, read } = captureOutput();

    try {
      await runOnboarding({
        env: {
          ...process.env,
          HOME: dir,
          USERPROFILE: dir,
          DISTILL_CONFIG_PATH: configPath,
          DISTILL_ONBOARDING_TUI: "false"
        },
        persisted: {
          model: "qwen-saved",
          host: "http://ollama.test/v1"
        },
        input: Readable.from(["codex\ncustom-codex\ncustom-spark\n123000\nn\n"]),
        output
      });

      expect(read()).toContain("codex-command");
      expect(await readPersistedConfig({ DISTILL_CONFIG_PATH: configPath })).toMatchObject({
        provider: "codex",
        codexCommand: "custom-codex",
        codexModel: "custom-spark",
        model: "qwen-saved",
        host: "http://ollama.test/v1",
        timeoutMs: 123000
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("shows local model download progress and warms the resolved local runtime", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "distill-onboarding-warm-"));
    const configPath = path.join(dir, "distill.config.ts");
    const { output, read } = captureOutput();
    let warmedConfig: RuntimeConfig | null = null;

    try {
      await runOnboarding({
        env: {
          ...process.env,
          HOME: dir,
          USERPROFILE: dir,
          DISTILL_CONFIG_PATH: configPath,
          DISTILL_ONBOARDING_TUI: "false"
        },
        input: Readable.from(["\n\n2\n127.0.0.1\n19009\n120000\nn\n"]),
        output,
        prepareLocalModel: async (config, onProgress) => {
          warmedConfig = config;
          onProgress?.(1);
        }
      });

      expect(read()).toContain("(0%) Downloading and loading Distill local model");
      expect(read()).toContain("(1%) Downloading and loading Distill local model");
      expect(read()).toContain("Local Distill model ready");
      expect(warmedConfig?.provider).toBe("local");
      expect(warmedConfig?.localConcurrency).toBe(2);
      expect(warmedConfig?.host).toBe("http://127.0.0.1:19009/v1");
      expect(await readPersistedConfig({ DISTILL_CONFIG_PATH: configPath })).toMatchObject({
        provider: "local",
        localConcurrency: 2,
        localHost: "127.0.0.1",
        localPort: 19009,
        timeoutMs: 120000
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
