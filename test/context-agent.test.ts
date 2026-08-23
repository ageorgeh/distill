import { describe, expect, it } from "bun:test";
import { buildContextAgentPrompt, CONTEXT_AGENT_INSTRUCTIONS, createCodexContextProvider } from "../src/context-agent";
import { resolveConfig } from "../src/config";
import type { ContextManifest } from "../src/context-manifest";

const request = {
  action: "gather" as const,
  workspaceRoot: "/repo",
  intent: "implement" as const,
  objective: "Fix the queue.",
  references: ["src/queue.ts"],
};

describe("context evidence selection", () => {
  it("quotes the parent task and confines Spark to one candidate-selection pass", () => {
    const prompt = buildContextAgentPrompt(request, { documentationIndexes: [] }, "relevant_symbols[1]: queue");
    expect(CONTEXT_AGENT_INSTRUCTIONS).toContain("deterministic Gortex over-gather");
    expect(CONTEXT_AGENT_INSTRUCTIONS).toContain("Do not search, inspect the filesystem, call tools");
    expect(CONTEXT_AGENT_INSTRUCTIONS).toContain("exactly one selection pass with no follow-up discovery");
    expect(CONTEXT_AGENT_INSTRUCTIONS).toContain("Cover each independent numbered");
    expect(CONTEXT_AGENT_INSTRUCTIONS).toContain("Prefer direct implementation owners");
    expect(CONTEXT_AGENT_INSTRUCTIONS).toContain("generated owners");
    expect(CONTEXT_AGENT_INSTRUCTIONS).toContain("complete deterministic Git changed-file list");
    expect(CONTEXT_AGENT_INSTRUCTIONS).toContain("only representative changed-file graph seeds");
    expect(CONTEXT_AGENT_INSTRUCTIONS).not.toContain("Do not substitute server");
    expect(CONTEXT_AGENT_INSTRUCTIONS).toContain("remove that label");
    expect(prompt).toContain('"objective": "Fix the queue."');
    expect(prompt).toContain("CANDIDATE_CONTEXT\nrelevant_symbols[1]: queue");
    expect(prompt).toContain("Do not resolve the quoted parent task");
  });

  it("runs one tool-disabled structured completion and parses its manifest", async () => {
    let calls = 0;
    let captured: Record<string, unknown> | undefined;
    const manifest: ContextManifest = {
      files: [{ path: "src/queue.ts", role: "edit", relevance: "Queue owner.", priority: 1, excerpts: [{ startLine: 10, endLine: 40, reason: "Queue transition." }] }],
      searchesCompleted: [{ query: "Gortex explore", matches: ["src/queue.ts:10 — queue"] }],
    };
    const provider = createCodexContextProvider(resolveConfig({ context: { model: "spark" } }).context, {
      completion: async (input) => {
        calls += 1;
        captured = input as unknown as Record<string, unknown>;
        return { text: JSON.stringify(manifest), durationMs: 2, usage: { inputTokens: 50, outputTokens: 10 } };
      },
    });
    const controller = new AbortController();
    const result = await provider.gather({ request, repositoryConfig: { documentationIndexes: [] }, candidateContext: "candidate graph" }, { signal: controller.signal });

    expect(calls).toBe(1);
    expect(result.manifest).toEqual(manifest);
    expect(captured).toMatchObject({ model: "spark", reasoningEffort: "low", signal: controller.signal });
    expect(captured?.outputSchema).toBeDefined();
    expect((captured?.prompt as { user: string }).user).toContain("candidate graph");
  });
});
