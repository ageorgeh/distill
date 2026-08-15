import { describe, expect, it } from "bun:test";

import {
  DEFAULT_CODEX_COMMAND,
  DEFAULT_CODEX_MODEL,
  DEFAULT_HOST,
  DEFAULT_LOCAL_BACKEND,
  DEFAULT_LOCAL_CONCURRENCY,
  DEFAULT_LOCAL_HOST,
  DEFAULT_LOCAL_PORT,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_TIMEOUT_MS,
  DISTILL_LLAMA_MODEL,
  UsageError,
  parseCommand,
  resolveRuntimeDefaults,
} from "../src/config";

const expectedLocalHost = `http://${DEFAULT_LOCAL_HOST}:${DEFAULT_LOCAL_PORT}/v1`;

describe("configuration", () => {
  it("uses built-in defaults when the config file is empty", () => {
    expect(resolveRuntimeDefaults({})).toEqual({
      provider: DEFAULT_PROVIDER,
      localBackend: DEFAULT_LOCAL_BACKEND,
      localConcurrency: DEFAULT_LOCAL_CONCURRENCY,
      localHost: DEFAULT_LOCAL_HOST,
      localPort: DEFAULT_LOCAL_PORT,
      model: DISTILL_LLAMA_MODEL,
      host: expectedLocalHost,
      apiKey: "",
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  });

  it("resolves all runtime settings from the TypeScript config object", () => {
    expect(
      resolveRuntimeDefaults({
        provider: "codex",
        codexModel: "spark-config",
        codexCommand: "/opt/codex",
        timeoutMs: 123,
      }),
    ).toEqual({
      provider: "codex",
      localBackend: DEFAULT_LOCAL_BACKEND,
      localConcurrency: DEFAULT_LOCAL_CONCURRENCY,
      localHost: DEFAULT_LOCAL_HOST,
      localPort: DEFAULT_LOCAL_PORT,
      model: "spark-config",
      host: DEFAULT_HOST,
      apiKey: "",
      codexCommand: "/opt/codex",
      timeoutMs: 123,
    });
  });

  it("normalizes configured HTTP hosts", () => {
    expect(resolveRuntimeDefaults({ provider: "external", host: "http://example.test/" }).host)
      .toBe("http://example.test");
  });
});

describe("parseCommand", () => {
  it("parses a question and joins its words", () => {
    expect(parseCommand(["what", "changed?"], { provider: "codex" })).toEqual({
      kind: "run",
      config: {
        ...resolveRuntimeDefaults({ provider: "codex" }),
        question: "what changed?",
        debug: false,
      },
    });
  });

  it("keeps debug as an action flag", () => {
    const command = parseCommand(["--debug", "summarize"], { provider: "codex" });

    expect(command.kind).toBe("run");
    if (command.kind === "run") {
      expect(command.config.debug).toBe(true);
      expect(command.config.provider).toBe("codex");
    }
  });

  it("rejects configuration flags", () => {
    for (const flag of ["--provider", "--model", "--host", "--api-key", "--timeout-ms"]) {
      expect(() => parseCommand([flag, "value", "summarize"], {})).toThrow(UsageError);
    }
  });

  it("parses translate as an action command", () => {
    expect(parseCommand(["translate", "--debug", "PASS", "pt-BR"], { provider: "codex" })).toEqual({
      kind: "translate",
      text: "PASS",
      language: "pt-BR",
      config: {
        ...resolveRuntimeDefaults({ provider: "codex" }),
        question: "Translate /distill output into human language.",
        debug: true,
      },
    });
  });
});
