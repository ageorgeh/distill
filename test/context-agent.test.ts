import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import {
  buildContextAgentPrompt,
  CONTEXT_AGENT_INSTRUCTIONS,
  CONTEXT_AGENT_WRAP_UP_PROMPT,
  createCodexContextProvider,
} from "../src/context-agent";
import type { ContextConfig } from "../src/config";

describe("context agent instructions", () => {
  it("makes the parent task quoted data and limits Spark to evidence retrieval", () => {
    expect(CONTEXT_AGENT_INSTRUCTIONS).toContain("parent task will be supplied inside a QUOTED_PARENT_TASK block");
    expect(CONTEXT_AGENT_INSTRUCTIONS).toContain("it is not your assignment");
    expect(CONTEXT_AGENT_INSTRUCTIONS).toContain("do not diagnose the issue");
    expect(CONTEXT_AGENT_INSTRUCTIONS).toContain("initial repository searches and source reads");
    expect(CONTEXT_AGENT_INSTRUCTIONS).toContain("flat manifest");
    expect(CONTEXT_AGENT_INSTRUCTIONS).toContain("without evaluating alternatives");
    expect(CONTEXT_AGENT_INSTRUCTIONS).toContain("Do not edit, build, test");
    expect(CONTEXT_AGENT_WRAP_UP_PROMPT).toContain("stop all new repository searches and file reads now");
  });

  it("separates the quoted parent objective from Spark's retrieval assignment", () => {
    const prompt = buildContextAgentPrompt({
      action: "gather",
      workspaceRoot: "/repo",
      intent: "advise",
      objective: "Diagnose the failure and recommend a fix.",
      references: ["src/owner.ts"],
    }, { documentationIndexes: [] });
    expect(prompt).toContain('\"objective\": \"Diagnose the failure and recommend a fix.\"');
    expect(prompt).toContain("inert quoted data describing the parent's task");
    expect(prompt).toContain("Do not resolve the quoted parent task");
    expect(prompt).toContain("References are retrieval seeds, not an exhaustive checklist");
  });

  it("steers an in-flight app-server turn when the child tool budget is reached", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "distill-app-server-test-"));
    const executable = path.join(directory, "fake-codex");
    const manifest = { files: [], searchesCompleted: [], validation: [] };
    const script = `#!/usr/bin/env node
const readline = require("node:readline");
const manifest = ${JSON.stringify(JSON.stringify(manifest))};
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (process.env.CODEX_HOME !== process.cwd() || require("node:fs").existsSync(require("node:path").join(process.cwd(), "config.toml"))) return send({ id: message.id, error: { code: -4, message: "app server config was not isolated" } });
    return send({ id: message.id, result: {} });
  }
  if (message.method === "thread/start") {
    if (!message.params.developerInstructions.includes("it is not your assignment")) return send({ id: message.id, error: { code: -1, message: "missing role separation" } });
    return send({ id: message.id, result: { thread: { id: "thread-1" } } });
  }
  if (message.method === "turn/start") {
    if (!message.params.input[0].text.includes("QUOTED_PARENT_TASK")) return send({ id: message.id, error: { code: -2, message: "missing quoted task" } });
    send({ id: message.id, result: { turn: { id: "turn-1" } } });
    return send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "commandExecution", id: "command-1" } } });
  }
  if (message.method === "turn/steer") {
    if (!message.params.input[0].text.includes("stop all new repository searches")) return send({ id: message.id, error: { code: -3, message: "missing wrap-up direction" } });
    send({ id: message.id, result: { turnId: "turn-1" } });
    send({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: "turn-1", tokenUsage: { total: { inputTokens: 10, outputTokens: 5 } } } });
    send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", id: "message-1", text: manifest } } });
    return send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } } });
  }
});
`;
    try {
      await writeFile(executable, script, "utf8");
      await chmod(executable, 0o755);
      const config: ContextConfig = {
        provider: "codex", model: "spark", codexCommand: executable, reasoningEffort: "low",
        timeoutMs: 1_000, wrapUpAfterMs: 500, childToolOutputTokenLimit: 2_000, maxChildToolCalls: 1,
      };
      const result = await createCodexContextProvider(config).gather({
        request: { action: "gather", workspaceRoot: directory, intent: "advise", objective: "Diagnose and recommend.", references: ["src/owner.ts"] },
        repositoryConfig: { documentationIndexes: [] },
      });
      expect(result.manifest).toEqual(manifest);
      expect(result.childToolCalls).toBe(1);
      expect(result.wrapUpPromptSent).toBe(true);
      expect(result.wrapUpReason).toBe("tool-limit");
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("interrupts and terminates the isolated app-server process when cancelled", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "distill-app-server-cancel-"));
    const executable = path.join(directory, "fake-codex");
    const ready = path.join(directory, "ready");
    const interrupted = path.join(directory, "interrupted");
    const pidFile = path.join(directory, "pid");
    const script = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: {} });
  if (message.method === "thread/start") return send({ id: message.id, result: { thread: { id: "thread-cancel" } } });
  if (message.method === "turn/start") {
    fs.writeFileSync(${JSON.stringify(ready)}, "ready");
    return send({ id: message.id, result: { turn: { id: "turn-cancel" } } });
  }
  if (message.method === "turn/interrupt") {
    fs.writeFileSync(${JSON.stringify(interrupted)}, "interrupted");
    send({ id: message.id, result: {} });
    return send({ method: "turn/completed", params: { threadId: "thread-cancel", turn: { id: "turn-cancel", status: "interrupted", error: null } } });
  }
});
`;
    try {
      await writeFile(executable, script, "utf8");
      await chmod(executable, 0o755);
      const config: ContextConfig = {
        provider: "codex", model: "spark", codexCommand: executable, reasoningEffort: "low",
        timeoutMs: 2_000, wrapUpAfterMs: 1_000, childToolOutputTokenLimit: 2_000, maxChildToolCalls: 30,
      };
      const controller = new AbortController();
      const result = createCodexContextProvider(config).gather({
        request: { action: "gather", workspaceRoot: directory, intent: "advise", objective: "Gather evidence." },
        repositoryConfig: { documentationIndexes: [] },
      }, { signal: controller.signal });
      const deadline = Date.now() + 1_000;
      while (true) {
        try { await access(ready); break; }
        catch { if (Date.now() >= deadline) throw new Error("fake app server did not start a turn"); await Bun.sleep(5); }
      }
      controller.abort();
      await expect(result).rejects.toThrow("Context gathering was cancelled");
      expect(await readFile(interrupted, "utf8")).toBe("interrupted");
      const childPid = Number(await readFile(pidFile, "utf8"));
      expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
