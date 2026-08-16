import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveConfig } from "../src/config";
import { createContextHandler } from "../src/context";
import type { ContextAgentProvider } from "../src/context-agent";

function provider(counter: { calls: number }): ContextAgentProvider {
  return { gather: async () => {
    counter.calls += 1;
    return { manifest: {
      scope: "Handler flow.", globalFindings: [], globalFiles: [], globalSearchesCompleted: [], globalValidation: [], globalGaps: [],
      concerns: [{ id: "owner", title: "Owner", summary: "The owner is worker.ts.", priority: 1, dependencies: [], findings: [], files: [{ path: "worker.ts", role: "edit", inspected: true, relevance: "Owner.", priority: 1, observations: [{ text: "Exports the handler." }], excerpts: [{ startLine: 1, endLine: 1, reason: "Entry point." }] }], searchesCompleted: [], validation: ["bun test"], gaps: [] }],
    } };
  } };
}

describe("context gather and packet handlers", () => {
  it("runs the provider once, persists a bundle, and retrieves packets without a provider", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "distill-context-handler-"));
    const telemetry = await mkdtemp(path.join(tmpdir(), "distill-context-store-"));
    try {
      await writeFile(path.join(root, "worker.ts"), "export const worker = true;\n", "utf8");
      const counter = { calls: 0 };
      const gather = createContextHandler(resolveConfig({}), { provider: provider(counter), telemetryDirectory: telemetry, resolveLimit: async () => ({ limit: 1_000, source: "default" }) });
      const index = await gather({ action: "gather", workspaceRoot: root, intent: "implement", objective: "Gather handler context." });
      const contextId = /id=([0-9a-f-]+)/.exec(index)?.[1]!;
      expect(counter.calls).toBe(1);
      const packetId = /packets: ([a-z0-9-]+)/.exec(index)?.[1]!;
      const restarted = createContextHandler(resolveConfig({}), { provider: provider(counter), telemetryDirectory: telemetry });
      expect(await restarted({ action: "packet", contextId, packetId })).toContain("worker.ts");
      expect(counter.calls).toBe(1);
      await expect(restarted({ action: "packet", contextId: "../bad", packetId })).rejects.toThrow("Invalid context ID");
    } finally { await rm(root, { recursive: true, force: true }); await rm(telemetry, { recursive: true, force: true }); }
  });
});
