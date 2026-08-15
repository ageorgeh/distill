import { describe, expect, it } from "bun:test";

import {
  chatCompletion,
  summarizeBatch,
  summarizeTranslate,
  summarizeWatch
} from "../src/llm";
import type { RuntimeConfig } from "../src/config";

const baseConfig: RuntimeConfig = {
  question: "Did tests pass? Return PASS or FAIL.",
  provider: "external",
  localBackend: "auto",
  localConcurrency: 5,
  localHost: "127.0.0.1",
  localPort: 8009,
  model: "qwen3.5:2b",
  host: "http://127.0.0.1:11434/v1",
  apiKey: "",
  timeoutMs: 100
};

describe("chatCompletion", () => {
  it("preserves nested base paths", async () => {
    let requestUrl = "";

    const output = await chatCompletion({
      baseUrl: "http://127.0.0.1:12434/engines/v1",
      apiKey: "not-needed",
      model: "ai/llama3.2",
      prompt: "hi",
      timeoutMs: 100,
      fetchImpl: async (input) => {
        requestUrl = String(input);

        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "  concise  " } }]
          }),
          { status: 200 }
        );
      }
    });

    expect(requestUrl).toBe("http://127.0.0.1:12434/engines/v1/chat/completions");
    expect(output).toBe("concise");
  });

  it("adds /v1 when the base URL does not include an API prefix", async () => {
    let requestUrl = "";

    await chatCompletion({
      baseUrl: "http://127.0.0.1:8000",
      apiKey: "",
      model: "qwen",
      prompt: "hi",
      timeoutMs: 100,
      fetchImpl: async (input) => {
        requestUrl = String(input);

        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" } }]
          }),
          { status: 200 }
        );
      }
    });

    expect(requestUrl).toBe("http://127.0.0.1:8000/v1/chat/completions");
  });

  it("throws when the provider returns a non-2xx status", async () => {
    await expect(
      chatCompletion({
        baseUrl: "http://127.0.0.1:8000",
        apiKey: "",
        model: "qwen",
        prompt: "hi",
        timeoutMs: 100,
        fetchImpl: async () => new Response("boom", { status: 500 })
      })
    ).rejects.toThrow("Request failed with 500.");
  });

  it("throws when the provider returns invalid JSON", async () => {
    await expect(
      chatCompletion({
        baseUrl: "http://127.0.0.1:8000",
        apiKey: "",
        model: "qwen",
        prompt: "hi",
        timeoutMs: 100,
        fetchImpl: async () => new Response("not-json", { status: 200 })
      })
    ).rejects.toThrow("Provider returned invalid JSON.");
  });

  it("throws when the response payload is missing choices", async () => {
    await expect(
      chatCompletion({
        baseUrl: "http://127.0.0.1:8000",
        apiKey: "",
        model: "qwen",
        prompt: "hi",
        timeoutMs: 100,
        fetchImpl: async () =>
          new Response(JSON.stringify({ choices: [] }), { status: 200 })
      })
    ).rejects.toThrow("Provider returned an invalid response payload.");

    await expect(
      chatCompletion({
        baseUrl: "http://127.0.0.1:8000",
        apiKey: "",
        model: "qwen",
        prompt: "hi",
        timeoutMs: 100,
        fetchImpl: async () =>
          new Response(JSON.stringify({}), { status: 200 })
      })
    ).rejects.toThrow("Provider returned an invalid response payload.");
  });

  it("throws when content is empty or whitespace-only", async () => {
    await expect(
      chatCompletion({
        baseUrl: "http://127.0.0.1:8000",
        apiKey: "",
        model: "qwen",
        prompt: "hi",
        timeoutMs: 100,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "   " } }]
            }),
            { status: 200 }
          )
      })
    ).rejects.toThrow("Provider returned an empty response.");
  });
});

describe("summarizeBatch", () => {
  it("routes every summary mode to Codex without HTTP or a local server", async () => {
    const calls: string[] = [];
    const dependencies = {
      ensureLocalServer: async () => { throw new Error("local server called"); },
      codexCompletion: async ({ prompt }: { prompt: { system: string; user: string } }) => {
        calls.push(prompt.user);
        return "CODEX";
      }
    };
    const config = {
      ...baseConfig,
      provider: "codex" as const,
      model: "gpt-5.3-codex-spark",
      codexCommand: "codex"
    };
    const noFetch = async () => { throw new Error("fetch called"); };

    expect(await summarizeBatch(config, "batch", dependencies, noFetch)).toBe("CODEX");
    expect(await summarizeTranslate(config, "text", "en", noFetch, dependencies)).toBe("CODEX");
    expect(await summarizeWatch(config, "old", "new", noFetch, dependencies)).toBe("CODEX");
    expect(calls).toHaveLength(3);
  });

  it("starts the local server before sending local-provider requests", async () => {
    const events: string[] = [];

    const output = await summarizeBatch(
      {
        ...baseConfig,
        provider: "local",
        model: "samuelfaj/distill-1.7B-4bit-MLX",
        host: "http://127.0.0.1:8009/v1"
      },
      "1 passed",
      {
        ensureLocalServer: async (config) => {
          events.push(`${config.provider}:${config.localBackend}`);
        }
      },
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "PASS" } }]
          }),
          { status: 200 }
        )
    );

    expect(output).toBe("PASS");
    expect(events).toEqual(["local:auto"]);
  });

  it("does not start the local server for explicitly external requests", async () => {
    const events: string[] = [];

    await summarizeBatch(
      baseConfig,
      "1 passed",
      {
        ensureLocalServer: async () => {
          events.push("unexpected");
        }
      },
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "PASS" } }]
          }),
          { status: 200 }
        )
    );

    expect(events).toEqual([]);
  });

  it("does not start the managed local server for Ollama-service requests", async () => {
    const events: string[] = [];

    await summarizeBatch(
      {
        ...baseConfig,
        provider: "ollama",
        model: "qwen3.5:4b",
        host: "http://127.0.0.1:11434/v1"
      },
      "1 passed",
      {
        ensureLocalServer: async () => {
          events.push("unexpected");
        }
      },
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "PASS" } }]
          }),
          { status: 200 }
        )
    );

    expect(events).toEqual([]);
  });

  it("limits concurrent local-provider HTTP requests to local-concurrency", async () => {
    let activeRequests = 0;
    let maxActiveRequests = 0;

    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        summarizeBatch(
          {
            ...baseConfig,
            provider: "local",
            localConcurrency: 2,
            host: "http://127.0.0.1:8009/v1"
          },
          `input ${index}`,
          {
            ensureLocalServer: async () => undefined
          },
          async () => {
            activeRequests += 1;
            maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
            await new Promise((resolve) => setTimeout(resolve, 5));
            activeRequests -= 1;

            return new Response(
              JSON.stringify({
                choices: [{ message: { content: "PASS" } }]
              }),
              { status: 200 }
            );
          }
        )
      )
    );

    expect(maxActiveRequests).toBe(2);
  });

  it("sends the batch prompt with config-derived params", async () => {
    let requestBody: unknown;

    const output = await summarizeBatch(
      baseConfig,
      "1 passed",
      async (_, init) => {
        requestBody = JSON.parse(String(init?.body ?? "{}"));

        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "PASS" } }]
          }),
          { status: 200 }
        );
      }
    );

    expect(output).toBe("PASS");
    const body = requestBody as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      temperature: number;
      max_tokens?: number;
    };
    expect(body.model).toBe("qwen3.5:2b");
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(512);
    expect(body.messages[0]!.role).toBe("system");
    expect(body.messages[1]!.role).toBe("user");
    expect(body.messages[1]!.content).toContain("1 passed");
    expect(body.messages[1]!.content).toContain(baseConfig.question);
  });

});

describe("summarizeTranslate", () => {
  it("asks the provider to translate compressed output into human language", async () => {
    let systemContent = "";
    let userContent = "";

    const output = await summarizeTranslate(
      baseConfig,
      [
        "Best:",
        "Fix auth bug.",
        "Pass: valid user allowed, tests pass.",
        "Tradeoff:",
        "Less context for reviewer."
      ].join("\n"),
      "en-US",
      async (_, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          messages: Array<{ role: string; content: string }>;
        };
        systemContent = body.messages[0]!.content;
        userContent = body.messages[1]!.content;

        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "Done because tests passed. Next step: ship it."
                }
              }
            ]
          }),
          { status: 200 }
        );
      }
    );

    expect(output).toBe("Done because tests passed. Next step: ship it.");
    expect(systemContent).toContain("compressed language");
    expect(systemContent).toContain("Best");
    expect(systemContent).toContain("Pass");
    expect(userContent).toContain("Fix auth bug.");
    expect(userContent).toContain("en-US");
  });
});

describe("summarizeWatch", () => {
  it("sends both cycles in the watch prompt", async () => {
    let userContent = "";

    await summarizeWatch(
      baseConfig,
      "failed: 0",
      "failed: 1",
      async (_, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          messages: Array<{ role: string; content: string }>;
        };
        userContent = body.messages[1]!.content;

        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "failure count rose" } }]
          }),
          { status: 200 }
        );
      }
    );

    expect(userContent).toContain("failed: 0");
    expect(userContent).toContain("failed: 1");
  });
});
