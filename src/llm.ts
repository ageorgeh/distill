import { DEFAULT_CODEX_COMMAND, type OutputConfig } from "./config";
import { codexCliCompletion } from "./codex-cli";
import { ensureLocalServer } from "./local-server";
import { buildOutputPrompt, type PromptMessages } from "./prompt";

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OutputSummaryRequest {
  command: string;
  question: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface OutputProvider { summarize(request: OutputSummaryRequest): Promise<string>; }

export interface ChatCompletionRequest {
  baseUrl: string; apiKey: string; model: string; prompt: string | PromptMessages;
  timeoutMs: number; maxTokens?: number; fetchImpl?: FetchImplementation;
}

function chatUrl(baseUrl: string): URL {
  const url = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  url.pathname = `${url.pathname.replace(/\/+$/, "") || "/v1"}/chat/completions`;
  return url;
}

export async function chatCompletion(request: ChatCompletionRequest): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const messages = typeof request.prompt === "string" ? [{ role: "user", content: request.prompt }] : [{ role: "system", content: request.prompt.system }, { role: "user", content: request.prompt.user }];
    const response = await (request.fetchImpl ?? fetch)(chatUrl(request.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${request.apiKey}` },
      body: JSON.stringify({ model: request.model, messages, temperature: 0, reasoning_effort: "none", max_tokens: request.maxTokens ?? 512 }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Request failed with ${response.status}.`);
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const result = payload.choices?.[0]?.message?.content?.trim();
    if (!result) throw new Error("Provider returned an empty response.");
    return result;
  } finally { clearTimeout(timer); }
}

export function createOutputProvider(config: OutputConfig, dependencies: { fetchImpl?: FetchImplementation; codexCompletion?: typeof codexCliCompletion } = {}): OutputProvider {
  return {
    async summarize(request) {
      const prompt = buildOutputPrompt(request);
      if (config.provider === "codex") {
        return (dependencies.codexCompletion ?? codexCliCompletion)({ model: config.model, executable: config.codexCommand ?? DEFAULT_CODEX_COMMAND, prompt, timeoutMs: config.timeoutMs });
      }
      if (config.provider === "local") await ensureLocalServer(config);
      return chatCompletion({ baseUrl: config.host, apiKey: config.apiKey, model: config.model, prompt, timeoutMs: config.timeoutMs, fetchImpl: dependencies.fetchImpl });
    },
  };
}
