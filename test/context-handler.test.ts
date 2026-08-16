import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveConfig } from "../src/config";
import { createContextHandler } from "../src/context";
import type { ContextAgentProvider } from "../src/context-agent";

function provider(counter: { calls: number }): ContextAgentProvider {
  return { gather: async () => {
    counter.calls += 1;
    return {
      usage: { inputTokens: 100, outputTokens: 20 }, childToolCalls: 3, wrapUpPromptSent: true, wrapUpReason: "time",
      manifest: {
        files: [{ path: "worker.ts", role: "edit", relevance: "Direct handler owner.", priority: 1, excerpts: [{ startLine: 1, endLine: 1, reason: "Entry point." }] }],
        searchesCompleted: [{ query: "worker", matches: ["worker.ts:1 — handler"] }],
        validation: ["bun test"],
      },
    };
  } };
}

describe("single-response context gathering", () => {
  it("runs the provider once and returns exact source directly", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "distill-context-handler-"));
    const telemetry = await mkdtemp(path.join(tmpdir(), "distill-context-telemetry-"));
    try {
      await writeFile(path.join(root, "worker.ts"), "export const worker = true;\n", "utf8");
      const counter = { calls: 0 };
      const gather = createContextHandler(resolveConfig({}), { provider: provider(counter), telemetryDirectory: telemetry, resolveLimit: async () => ({ limit: 24_000, source: "default" }) });
      const result = await gather({ action: "gather", workspaceRoot: root, intent: "implement", objective: "Gather handler context." });
      expect(counter.calls).toBe(1);
      expect(result).toContain("DISTILL CONTEXT");
      expect(result).toContain("EXACT SOURCE\nworker.ts:1-1");
      expect(result).not.toContain("packet");
      const files = await readdir(path.join(telemetry, "invocations"));
      const stored = JSON.parse(await readFile(path.join(telemetry, "invocations", files[0]!), "utf8")) as Record<string, unknown>;
      expect(stored).toMatchObject({
        providerUsage: { inputTokens: 100, outputTokens: 20 }, childCommandCalls: 3, wrapUpPromptSent: true,
        wrapUpReason: "time", broadContext: false, resultBytes: Buffer.byteLength(result),
      });
      expect(stored.sourceManifest).toBeDefined();
    } finally { await rm(root, { recursive: true, force: true }); await rm(telemetry, { recursive: true, force: true }); }
  });

  it("records broad-range splitting while returning the source instead of a failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "distill-context-durable-"));
    const telemetry = await mkdtemp(path.join(tmpdir(), "distill-context-durable-telemetry-"));
    try {
      await writeFile(path.join(root, "task.md"), Array.from({ length: 260 }, (_, index) => `task line ${index + 1}`).join("\n"), "utf8");
      const durableProvider: ContextAgentProvider = { gather: async () => ({
        manifest: {
          files: [{ path: "task.md", role: "documentation", relevance: "Authoritative task reference.", priority: 2, excerpts: [{ startLine: 1, endLine: 260, reason: "Task contract." }] }],
          searchesCompleted: [], validation: [],
        },
      }) };
      const gather = createContextHandler(resolveConfig({}), { provider: durableProvider, telemetryDirectory: telemetry, resolveLimit: async () => ({ limit: 24_000, source: "default" }) });
      const result = await gather({ action: "gather", workspaceRoot: root, intent: "implement", objective: "Gather durable context." });
      expect(result).toContain("task.md:1-80");
      expect(result).toContain("260 | task line 260");
      const files = await readdir(path.join(telemetry, "invocations"));
      const stored = JSON.parse(await readFile(path.join(telemetry, "invocations", files[0]!), "utf8")) as Record<string, unknown>;
      expect(stored.manifestValidation).toEqual(["Split broad excerpt in task.md:1-260"]);
      expect(stored.omittedSources).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); await rm(telemetry, { recursive: true, force: true }); }
  });

  it("passes caller cancellation to the context provider", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "distill-context-cancel-"));
    const telemetry = await mkdtemp(path.join(tmpdir(), "distill-context-cancel-telemetry-"));
    try {
      const provider: ContextAgentProvider = { gather: async (_request, options) => new Promise((_resolve, reject) => {
        if (options?.signal?.aborted) { reject(new Error("provider cancelled")); return; }
        options?.signal?.addEventListener("abort", () => reject(new Error("provider cancelled")), { once: true });
      }) };
      const gather = createContextHandler(resolveConfig({}), { provider, telemetryDirectory: telemetry });
      const controller = new AbortController();
      const result = gather({ action: "gather", workspaceRoot: root, intent: "advise", objective: "Gather until cancelled." }, { signal: controller.signal });
      controller.abort();
      await expect(result).rejects.toThrow("provider cancelled");
      const files = await readdir(path.join(telemetry, "invocations"));
      const stored = JSON.parse(await readFile(path.join(telemetry, "invocations", files[0]!), "utf8")) as Record<string, unknown>;
      expect(stored).toMatchObject({ failurePhase: "provider", failure: "provider cancelled" });
    } finally { await rm(root, { recursive: true, force: true }); await rm(telemetry, { recursive: true, force: true }); }
  });
});
