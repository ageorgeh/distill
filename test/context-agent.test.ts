import { describe, expect, it } from "bun:test";
import { CONTEXT_AGENT_INSTRUCTIONS, finalAgentMessageFromJsonl, parseContextAgentJsonl } from "../src/context-agent";

describe("context agent instructions", () => {
  it("keeps one read-only comprehensive pass without a command cap or task restatement", () => {
    expect(CONTEXT_AGENT_INSTRUCTIONS).toContain("parent agent has already read and understood");
    expect(CONTEXT_AGENT_INSTRUCTIONS).toContain("Do not rewrite or summarize that task");
    expect(CONTEXT_AGENT_INSTRUCTIONS).toContain("Do not edit, build, test");
    expect(CONTEXT_AGENT_INSTRUCTIONS).toContain("priority-one concern");
    expect(CONTEXT_AGENT_INSTRUCTIONS).not.toContain("16-command");
  });

  it("counts the current completed command-execution JSONL event shape without making parsing fatal", () => {
    const jsonl = [
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "rg context" } }),
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "sed -n" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 42 } }),
      "not-json",
    ].join("\n");
    expect(parseContextAgentJsonl(jsonl)).toEqual({ childToolCalls: 2, usage: { input_tokens: 42 } });
  });

  it("recovers the final structured message from JSONL when output-last-message is absent", () => {
    expect(finalAgentMessageFromJsonl(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"scope":"x"}' } })}\n`)).toBe('{"scope":"x"}');
  });
});
