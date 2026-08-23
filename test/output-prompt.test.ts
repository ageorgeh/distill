import { describe, expect, it } from "bun:test";
import type { CodexCliRequest } from "../src/codex-cli";
import { resolveConfig } from "../src/config";
import { createOutputProvider, type OutputSummaryRequest } from "../src/llm";
import { buildOutputPrompt } from "../src/prompt";

const request: OutputSummaryRequest = {
  command: "pnpm run verify",
  question: "Report each validation phase and exact failures.",
  exitCode: 1,
  stdout: "format passed\ntests failed",
  stderr: "src/example.ts:7:9 error TS1234: exact failure",
  targetOutputBytes: 2_000,
  maxOutputBytes: 8_000,
};

describe("output summarization", () => {
  it("requests a compact agent-to-agent line protocol", () => {
    const prompt = buildOutputPrompt(request);
    expect(prompt.system).toContain("Do not use Markdown, bullets, headings, code fences, emoji, conversational language, or niceties.");
    expect(prompt.system).toContain("never repeat the overall outcome or exit code");
    expect(prompt.system).toContain("Never shorten them with ellipses");
    expect(prompt.system).toContain("<scope> skipped [reason=<short reason>]");
    expect(prompt.system).toContain("Target at most 2000 bytes. The hard maximum is 8000 bytes.");
    expect(prompt.user).toContain("src/example.ts:7:9 error TS1234: exact failure");
  });

  it("uses low reasoning effort for Codex command-output extraction", async () => {
    let captured: CodexCliRequest | undefined;
    const provider = createOutputProvider(resolveConfig({}).output, {
      codexCompletion: async (value) => {
        captured = value;
        return { text: "tests fail total=1", durationMs: 1 };
      },
    });
    expect((await provider.summarize(request)).text).toBe("tests fail total=1");
    expect(captured?.reasoningEffort).toBe("low");
  });
});
