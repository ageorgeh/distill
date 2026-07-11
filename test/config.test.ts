import { describe, expect, it } from "bun:test";

import {
  DEFAULT_AUTO_LEARN,
  DEFAULT_AUTO_LEARN_SCOPE,
  DEFAULT_AUTO_LEARN_SOURCE,
  DEFAULT_AUTO_PROMOTE_SCOPES,
  DEFAULT_CODEX_COMMAND,
  DEFAULT_CODEX_MODEL,
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

describe("Codex provider configuration", () => {
  it("resolves independent Codex defaults and persisted/env values", () => {
    expect(resolveRuntimeDefaults({ DISTILL_PROVIDER: "codex" }, {})).toMatchObject({
      provider: "codex",
      model: DEFAULT_CODEX_MODEL,
      codexCommand: DEFAULT_CODEX_COMMAND
    });
    expect(resolveRuntimeDefaults(
      {
        DISTILL_PROVIDER: "codex",
        DISTILL_CODEX_MODEL: "env-spark",
        DISTILL_CODEX_COMMAND: "/opt/codex"
      },
      { model: "qwen-saved", codexModel: "saved-spark", codexCommand: "saved-codex" }
    )).toMatchObject({ model: "env-spark", codexCommand: "/opt/codex" });
  });

  it("keeps Codex selected for model overrides without changing the saved API model", () => {
    const persisted = { provider: "codex" as const, model: "qwen-saved", codexModel: "spark-saved" };
    const command = parseCommand(["--model", "other-model", "summarize"], {}, persisted);
    expect(command.kind).toBe("run");
    if (command.kind === "run") {
      expect(command.config.provider).toBe("codex");
      expect(command.config.model).toBe("other-model");
    }
    expect(persisted.model).toBe("qwen-saved");
  });

  it("accepts explicit Codex and rejects its incompatible HTTP options", () => {
    const command = parseCommand(
      ["--provider", "codex", "--model", "custom", "summarize"], {}, {}
    );
    expect(command.kind === "run" && command.config).toMatchObject({
      provider: "codex",
      model: "custom",
      codexCommand: "codex"
    });
    expect(() => parseCommand(
      ["--provider", "codex", "--host", "http://example.test", "summarize"], {}, {}
    )).toThrow("incompatible");
    expect(() => parseCommand(
      ["--provider", "codex", "--api-key", "secret", "summarize"], {}, {}
    )).toThrow("incompatible");
  });
});

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

  it("uses persisted Ollama settings without starting the managed local server path", () => {
    const command = parseCommand(
      ["summarize"],
      {},
      {
        provider: "ollama",
        model: "qwen3.5:4b",
        host: "http://127.0.0.1:11434/v1",
        apiKey: "",
        timeoutMs: 50
      }
    );

    expect(command).toMatchObject({
      kind: "run",
      config: {
        question: "summarize",
        provider: "ollama",
        model: "qwen3.5:4b",
        host: "http://127.0.0.1:11434/v1",
        apiKey: "",
        timeoutMs: 50
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

  it("directs legacy config commands to the TypeScript file", () => {
    expect(() => parseCommand(["config", "provider", "external"], {}, {}))
      .toThrow("Edit distill.config.ts instead");
  });

  it("parses inline Ollama provider overrides", () => {
    const command = parseCommand(
      [
        "--provider",
        "ollama",
        "--model",
        "qwen3.5:4b",
        "--host",
        "http://127.0.0.1:11434/v1",
        "summarize"
      ],
      {},
      {}
    );

    expect(command).toMatchObject({
      kind: "run",
      config: {
        provider: "ollama",
        model: "qwen3.5:4b",
        host: "http://127.0.0.1:11434/v1",
        apiKey: ""
      }
    });
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
