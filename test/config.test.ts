import { describe, expect, it } from "bun:test";

import {
  DEFAULT_AUTO_LEARN,
  DEFAULT_AUTO_LEARN_SCOPE,
  DEFAULT_AUTO_LEARN_SOURCE,
  DEFAULT_AUTO_PROMOTE_SCOPES,
  DEFAULT_HOST,
  DEFAULT_LOCAL_BACKEND,
  DEFAULT_LOCAL_CONCURRENCY,
  DEFAULT_LOCAL_HOST,
  DEFAULT_LOCAL_PORT,
  DEFAULT_MAX_PROMPT_DSL_ENTRIES,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_TIMEOUT_MS,
  UsageError,
  parseCommand,
  resolveRuntimeDefaults
} from "../src/config";

const defaultAutoLearnConfig = {
  autoLearn: DEFAULT_AUTO_LEARN,
  autoLearnScope: DEFAULT_AUTO_LEARN_SCOPE,
  autoLearnSource: DEFAULT_AUTO_LEARN_SOURCE,
  autoPromoteScopes: DEFAULT_AUTO_PROMOTE_SCOPES,
  maxPromptDslEntries: DEFAULT_MAX_PROMPT_DSL_ENTRIES,
  debug: false
};
const expectedLocalModel =
  process.platform === "darwin" && process.arch === "arm64"
    ? "samuelfaj/distill-1.7B-4bit-MLX"
    : "distill-local";
const expectedLocalHost = `http://${DEFAULT_LOCAL_HOST}:${DEFAULT_LOCAL_PORT}/v1`;

describe("parseCommand", () => {
  it("parses explicit onboarding", () => {
    expect(parseCommand(["onboard"], {}, {})).toEqual({ kind: "onboard" });
  });

  it("rejects empty arguments", () => {
    expect(() => parseCommand([], {}, {})).toThrow(UsageError);
  });

  it("parses dsl commands", () => {
    expect(parseCommand(["dsl", "show", "--scope", "global"], {}, {})).toEqual({
      kind: "dsl",
      args: ["show", "--scope", "global"]
    });
  });

  it("parses defaults and joins the question", () => {
    const command = parseCommand(["what", "changed?"], {}, {});

    expect(command).toEqual({
      kind: "run",
      config: {
        question: "what changed?",
        provider: DEFAULT_PROVIDER,
        localBackend: DEFAULT_LOCAL_BACKEND,
        localConcurrency: DEFAULT_LOCAL_CONCURRENCY,
        localHost: DEFAULT_LOCAL_HOST,
        localPort: DEFAULT_LOCAL_PORT,
        model: expectedLocalModel,
        host: expectedLocalHost,
        apiKey: "",
        timeoutMs: DEFAULT_TIMEOUT_MS,
        datasetEnabled: true,
        datasetPath: undefined,
        ...defaultAutoLearnConfig
      }
    });
  });

  it("supports explicit flags", () => {
    const command = parseCommand(
      [
        "--model",
        "mini",
        "--host=http://example.test",
        "--timeout-ms",
        "10",
        "--api-key",
        "secret",
        "summarize"
      ],
      {},
      {}
    );

    expect(command).toEqual({
      kind: "run",
      config: {
        question: "summarize",
        provider: "external",
        localBackend: DEFAULT_LOCAL_BACKEND,
        localConcurrency: DEFAULT_LOCAL_CONCURRENCY,
        localHost: DEFAULT_LOCAL_HOST,
        localPort: DEFAULT_LOCAL_PORT,
        model: "mini",
        host: "http://example.test",
        apiKey: "secret",
        timeoutMs: 10,
        datasetEnabled: true,
        datasetPath: undefined,
        ...defaultAutoLearnConfig
      }
    });
  });

  it("supports debug mode via flag", () => {
    const command = parseCommand(["--debug", "summarize"], {}, {});

    expect(command).toEqual({
      kind: "run",
      config: {
        question: "summarize",
        provider: DEFAULT_PROVIDER,
        localBackend: DEFAULT_LOCAL_BACKEND,
        localConcurrency: DEFAULT_LOCAL_CONCURRENCY,
        localHost: DEFAULT_LOCAL_HOST,
        localPort: DEFAULT_LOCAL_PORT,
        model: expectedLocalModel,
        host: expectedLocalHost,
        apiKey: "",
        timeoutMs: DEFAULT_TIMEOUT_MS,
        datasetEnabled: true,
        datasetPath: undefined,
        ...defaultAutoLearnConfig,
        debug: true
      }
    });
  });

  it("parses translate command with the default human language", () => {
    expect(parseCommand(["translate", "Best:\nFix auth bug.\nPass: tests pass"], {}, {})).toEqual({
      kind: "translate",
      text: "Best:\nFix auth bug.\nPass: tests pass",
      language: "en-US",
      config: {
        question: "Translate /distill output into human language.",
        provider: DEFAULT_PROVIDER,
        localBackend: DEFAULT_LOCAL_BACKEND,
        localConcurrency: DEFAULT_LOCAL_CONCURRENCY,
        localHost: DEFAULT_LOCAL_HOST,
        localPort: DEFAULT_LOCAL_PORT,
        model: expectedLocalModel,
        host: expectedLocalHost,
        apiKey: "",
        timeoutMs: DEFAULT_TIMEOUT_MS,
        datasetEnabled: true,
        datasetPath: undefined,
        ...defaultAutoLearnConfig
      }
    });
  });

  it("parses translate command with an explicit human language", () => {
    expect(parseCommand(["translate", "Dict: be=backend\nDo: patch be", "pt-BR"], {}, {})).toEqual({
      kind: "translate",
      text: "Dict: be=backend\nDo: patch be",
      language: "pt-BR",
      config: {
        question: "Translate /distill output into human language.",
        provider: DEFAULT_PROVIDER,
        localBackend: DEFAULT_LOCAL_BACKEND,
        localConcurrency: DEFAULT_LOCAL_CONCURRENCY,
        localHost: DEFAULT_LOCAL_HOST,
        localPort: DEFAULT_LOCAL_PORT,
        model: expectedLocalModel,
        host: expectedLocalHost,
        apiKey: "",
        timeoutMs: DEFAULT_TIMEOUT_MS,
        datasetEnabled: true,
        datasetPath: undefined,
        ...defaultAutoLearnConfig
      }
    });
  });

  it("uses persisted defaults when present", () => {
    const command = parseCommand(
      ["summarize"],
      {},
      {
        model: "saved-model",
        host: "http://saved.test",
        apiKey: "saved-key",
        timeoutMs: 50,
        datasetEnabled: false,
        datasetPath: "/tmp/distill.jsonl"
      }
    );

    expect(command).toEqual({
      kind: "run",
      config: {
        question: "summarize",
        provider: "local",
        localBackend: DEFAULT_LOCAL_BACKEND,
        localConcurrency: DEFAULT_LOCAL_CONCURRENCY,
        localHost: DEFAULT_LOCAL_HOST,
        localPort: DEFAULT_LOCAL_PORT,
        model: expectedLocalModel,
        host: expectedLocalHost,
        apiKey: "",
        timeoutMs: 50,
        datasetEnabled: false,
        datasetPath: "/tmp/distill.jsonl",
        ...defaultAutoLearnConfig
      }
    });
  });

  it("treats stale persisted provider names as local defaults instead of blocking the CLI", () => {
    expect(
      resolveRuntimeDefaults(
        {},
        {
          provider: "openai-compatible" as "local",
          model: "saved-model",
          host: "http://saved.test",
          apiKey: "saved-key"
        }
      )
    ).toMatchObject({
      provider: "local",
      model: expectedLocalModel,
      host: expectedLocalHost,
      apiKey: ""
    });
  });

  it("prefers env over persisted defaults", () => {
    expect(
      resolveRuntimeDefaults(
        {
          DISTILL_MODEL: "env-model",
          DISTILL_HOST: "http://env.test",
          DISTILL_API_KEY: "env-key",
      DISTILL_PROVIDER: "external",
      DISTILL_LOCAL_BACKEND: "llamacpp",
      DISTILL_LOCAL_CONCURRENCY: "7",
      DISTILL_LOCAL_HOST: "127.0.0.2",
      DISTILL_LOCAL_PORT: "8011",
      DISTILL_TIMEOUT_MS: "999",
      DISTILL_DATASET_ENABLED: "false",
      DISTILL_DATASET_PATH: "/tmp/env-distill.jsonl",
      DISTILL_AUTO_LEARN: "false",
      DISTILL_AUTO_PROMOTE_SCOPES: "false",
      DISTILL_MAX_PROMPT_DSL_ENTRIES: "12"
        },
        {
          model: "saved-model",
          host: "http://saved.test",
          apiKey: "saved-key",
          timeoutMs: 5,
          datasetEnabled: true,
          datasetPath: "/tmp/saved-distill.jsonl"
        }
      )
    ).toEqual({
      provider: "external",
      localBackend: "llamacpp",
      localConcurrency: 7,
      localHost: "127.0.0.2",
      localPort: 8011,
      model: "env-model",
      host: "http://env.test",
      apiKey: "env-key",
      timeoutMs: 999,
      datasetEnabled: false,
      datasetPath: "/tmp/env-distill.jsonl",
      autoLearn: false,
      autoLearnScope: "project",
      autoLearnSource: "output",
      autoPromoteScopes: false,
      maxPromptDslEntries: 12
      ,
      debug: false
    });
  });

  it("enables debug from env", () => {
    expect(resolveRuntimeDefaults({ DISTILL_DEBUG: "true" }, {}).debug).toBe(true);
  });

  it("treats legacy external env overrides as external even when persisted provider is local", () => {
    expect(
      resolveRuntimeDefaults(
        {
          DISTILL_HOST: "http://env.test",
          DISTILL_MODEL: "env-model"
        },
        {
          provider: "local",
          host: "http://saved.test",
          model: "saved-model"
        }
      )
    ).toMatchObject({
      provider: "external",
      host: "http://env.test",
      model: "env-model"
    });
  });

  it("parses config set commands", () => {
    expect(parseCommand(["config", "provider", "external"], {}, {})).toEqual({
      kind: "configSet",
      key: "provider",
      value: "external"
    });

    expect(parseCommand(["config", "local-backend", "mlx"], {}, {})).toEqual({
      kind: "configSet",
      key: "local-backend",
      value: "mlx"
    });

    expect(parseCommand(["config", "local-concurrency", "9"], {}, {})).toEqual({
      kind: "configSet",
      key: "local-concurrency",
      value: 9
    });

    expect(parseCommand(["config", "local-host", "127.0.0.9"], {}, {})).toEqual({
      kind: "configSet",
      key: "local-host",
      value: "127.0.0.9"
    });

    expect(parseCommand(["config", "local-port", "8019"], {}, {})).toEqual({
      kind: "configSet",
      key: "local-port",
      value: 8019
    });

    expect(parseCommand(["config", "model", "my-model"], {}, {})).toEqual({
      kind: "configSet",
      key: "model",
      value: "my-model"
    });

    expect(
      parseCommand(["config", "host", "http://127.0.0.1:8010/v1"], {}, {})
    ).toEqual({
      kind: "configSet",
      key: "host",
      value: "http://127.0.0.1:8010/v1"
    });

    expect(parseCommand(["config", "timeout-ms", "30000"], {}, {})).toEqual({
      kind: "configSet",
      key: "timeout-ms",
      value: 30000
    });

    expect(parseCommand(["config", "dataset-enabled", "false"], {}, {})).toEqual({
      kind: "configSet",
      key: "dataset-enabled",
      value: false
    });

    expect(
      parseCommand(["config", "dataset-path", "/tmp/distill.jsonl"], {}, {})
    ).toEqual({
      kind: "configSet",
      key: "dataset-path",
      value: "/tmp/distill.jsonl"
    });

    expect(parseCommand(["config", "auto-learn", "false"], {}, {})).toEqual({
      kind: "configSet",
      key: "auto-learn",
      value: false
    });

    expect(parseCommand(["config", "auto-promote-scopes", "false"], {}, {})).toEqual({
      kind: "configSet",
      key: "auto-promote-scopes",
      value: false
    });

    expect(parseCommand(["config", "max-prompt-dsl-entries", "12"], {}, {})).toEqual({
      kind: "configSet",
      key: "max-prompt-dsl-entries",
      value: 12
    });
  });

  it("rejects unknown config keys", () => {
    expect(() => parseCommand(["config", "unknown-provider", "openai"], {}, {})).toThrow(
      UsageError
    );
  });

  it("rejects invalid provider and local backend values", () => {
    expect(() => parseCommand(["config", "provider", "openai"], {}, {})).toThrow(
      UsageError
    );
    expect(() => parseCommand(["config", "local-backend", "ollama"], {}, {})).toThrow(
      UsageError
    );
  });

  it("normalizes trailing slash on host", () => {
    expect(
      resolveRuntimeDefaults(
        { DISTILL_HOST: "http://example.test/v1/" },
        {}
      ).host
    ).toBe("http://example.test/v1");
  });

  it("throws on missing translate text", () => {
    expect(() => parseCommand(["translate"], {}, {})).toThrow(UsageError);
  });

  it("throws on extra translate arguments", () => {
    expect(() =>
      parseCommand(["translate", "Best:\nDone.", "pt-BR", "extra"], {}, {})
    ).toThrow(UsageError);
  });

  it("throws on unknown flag", () => {
    expect(() => parseCommand(["--provider", "openai", "q"], {}, {})).toThrow(
      UsageError
    );
  });
});
