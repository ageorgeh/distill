import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  readPersistedConfig,
  resolveConfigPath,
  setPersistedConfigValue
} from "../src/user-config";

describe("user config", () => {
  it("writes and reads persisted config values", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "distill-config-"));
    const configPath = path.join(dir, "config.json");

    try {
      await setPersistedConfigValue(
        { DISTILL_CONFIG_PATH: configPath },
        "model",
        "qwen3.5:2b"
      );
      await setPersistedConfigValue(
        { DISTILL_CONFIG_PATH: configPath },
        "dataset-enabled",
        false
      );
      await setPersistedConfigValue(
        { DISTILL_CONFIG_PATH: configPath },
        "dataset-path",
        "/tmp/distill.jsonl"
      );
      await setPersistedConfigValue(
        { DISTILL_CONFIG_PATH: configPath },
        "provider",
        "local"
      );
      await setPersistedConfigValue(
        { DISTILL_CONFIG_PATH: configPath },
        "local-backend",
        "llamacpp"
      );
      await setPersistedConfigValue(
        { DISTILL_CONFIG_PATH: configPath },
        "local-concurrency",
        5
      );
      await setPersistedConfigValue(
        { DISTILL_CONFIG_PATH: configPath },
        "local-host",
        "127.0.0.1"
      );
      await setPersistedConfigValue(
        { DISTILL_CONFIG_PATH: configPath },
        "local-port",
        8009
      );

      expect(await readPersistedConfig({ DISTILL_CONFIG_PATH: configPath })).toEqual({
        model: "qwen3.5:2b",
        datasetEnabled: false,
        datasetPath: "/tmp/distill.jsonl",
        provider: "local",
        localBackend: "llamacpp",
        localConcurrency: 5,
        localHost: "127.0.0.1",
        localPort: 8009
      });

      const raw = JSON.parse(await readFile(configPath, "utf8"));
      expect(raw).toEqual({
        model: "qwen3.5:2b",
        datasetEnabled: false,
        datasetPath: "/tmp/distill.jsonl",
        provider: "local",
        localBackend: "llamacpp",
        localConcurrency: 5,
        localHost: "127.0.0.1",
        localPort: 8009
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves config path from explicit path, explicit dir, package root, and cwd", () => {
    expect(
      resolveConfigPath({
        DISTILL_CONFIG_PATH: "/tmp/custom-distill.json"
      })
    ).toBe("/tmp/custom-distill.json");

    expect(
      resolveConfigPath({
        DISTILL_CONFIG_DIR: "/tmp/custom-distill"
      })
    ).toBe(path.join("/tmp/custom-distill", "config.json"));

    expect(
      resolveConfigPath({
        DISTILL_PACKAGE_ROOT: "/tmp/package-root"
      })
    ).toBe(path.join("/tmp/package-root", "config.json"));

    expect(resolveConfigPath({})).toBe(path.join(process.cwd(), "config.json"));
  });
});
