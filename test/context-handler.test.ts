import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveConfig } from "../src/config";
import { createContextHandler } from "../src/context";
import type { ContextAgentProvider } from "../src/context-agent";
import type { GortexContextProvider } from "../src/gortex-context";

function retriever(counter?: { calls: number }): GortexContextProvider {
  return { gather: async () => {
    if (counter) counter.calls += 1;
    return { text: "graph candidates", durationMs: 5, bytes: 16, rawBytes: 16, truncated: false, command: ["gortex", "explore"], retrievalTaskBytes: 20, explicitReferenceCount: 0, gitReferenceCount: 0, selectedGitReferences: [], gitSeedDecisions: [], gitAreaDigest: "", supplementedReferences: [], documentationIndexes: [], deterministicEvidenceBytes: 0 };
  } };
}

function provider(counter: { calls: number }): ContextAgentProvider {
  return { gather: async () => {
    counter.calls += 1;
    return {
      usage: { inputTokens: 100, outputTokens: 20 },
      manifest: {
        files: [{ path: "worker.ts", role: "edit", relevance: "Direct handler owner.", priority: 1, excerpts: [{ startLine: 1, endLine: 1, reason: "Entry point." }] }],
        searchesCompleted: [{ query: "worker", matches: ["worker.ts:1 — handler"] }],
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
      const retrievalCounter = { calls: 0 };
      const gather = createContextHandler(resolveConfig({}), { provider: provider(counter), retriever: retriever(retrievalCounter), telemetryDirectory: telemetry, resolveLimit: async () => ({ limit: 24_000, source: "default" }) });
      const result = await gather({ action: "gather", workspaceRoot: root, intent: "implement", objective: "Gather handler context." });
      expect(counter.calls).toBe(1);
      expect(retrievalCounter.calls).toBe(1);
      expect(result).toContain("DISTILL CONTEXT");
      expect(result).toContain("EXACT SOURCE\nworker.ts:1-1");
      expect(result).not.toContain("packet");
      const files = await readdir(path.join(telemetry, "invocations"));
      const stored = JSON.parse(await readFile(path.join(telemetry, "invocations", files[0]!), "utf8")) as Record<string, unknown>;
      expect(stored).toMatchObject({
        providerUsage: { inputTokens: 100, outputTokens: 20 }, childCommandCalls: 0,
        broadContext: false, resultBytes: Buffer.byteLength(result),
        gortex: { durationMs: 5, bytes: 16, rawBytes: 16, truncated: false, command: ["gortex", "explore"], retrievalTaskBytes: 20 },
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
          searchesCompleted: [],
        },
      }) };
      const gather = createContextHandler(resolveConfig({}), { provider: durableProvider, retriever: retriever(), telemetryDirectory: telemetry, resolveLimit: async () => ({ limit: 24_000, source: "default" }) });
      const result = await gather({ action: "gather", workspaceRoot: root, intent: "implement", objective: "Gather durable context." });
      expect(result).toContain("task.md:1-80");
      expect(result).toContain("260 | task line 260");
      const files = await readdir(path.join(telemetry, "invocations"));
      const stored = JSON.parse(await readFile(path.join(telemetry, "invocations", files[0]!), "utf8")) as Record<string, unknown>;
      expect(stored.manifestValidation).toEqual(["Split broad excerpt in task.md:1-260"]);
      expect(stored.omittedSources).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); await rm(telemetry, { recursive: true, force: true }); }
  });

  it("makes review Git locations mandatory retrieval seeds and passes documentation evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "distill-context-review-"));
    const telemetry = await mkdtemp(path.join(tmpdir(), "distill-context-review-telemetry-"));
    try {
      await mkdir(path.join(root, ".distill"));
      await writeFile(path.join(root, ".distill", "config.toml"), "[context]\ndefault_base = \"dev\"\ndocumentation_indexes = [\"docs/llms.txt\"]\n", "utf8");
      await writeFile(path.join(root, "worker.ts"), "export const worker = true;\n", "utf8");
      let retrievalRequest: unknown;
      let retrievalOptions: unknown;
      const reviewRetriever: GortexContextProvider = { gather: async (request, options) => {
        retrievalRequest = request;
        retrievalOptions = options;
        return { text: "review candidates", durationMs: 1, bytes: 17, rawBytes: 17, truncated: false, command: ["gortex", "explore"], retrievalTaskBytes: 42, explicitReferenceCount: 1, gitReferenceCount: 1, selectedGitReferences: ["worker.ts"], gitSeedDecisions: [], gitAreaDigest: "- root: 1 file", supplementedReferences: ["worker.ts"], documentationIndexes: ["docs/llms.txt"], deterministicEvidenceBytes: 12 };
      } };
      const gather = createContextHandler(resolveConfig({}), {
        provider: provider({ calls: 0 }),
        retriever: reviewRetriever,
        gitContext: { gather: async () => ({ references: ["worker.ts"], changes: [{ path: "worker.ts", additions: 1, deletions: 0, sources: ["committed"] }], text: "review patch", commands: [["git", "diff"]], truncated: false }) },
        telemetryDirectory: telemetry,
        resolveLimit: async () => ({ limit: 24_000, source: "default" }),
      });
      await gather({ action: "gather", workspaceRoot: root, intent: "review", objective: "Review this branch.", references: ["Task 085"] });
      expect(retrievalRequest).toMatchObject({ baseRef: "dev", references: ["Task 085"] });
      expect(retrievalOptions).toMatchObject({ documentationIndexes: ["docs/llms.txt"], deterministicEvidence: "review patch", gitChanges: [{ path: "worker.ts", additions: 1, deletions: 0, sources: ["committed"] }] });
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
      const gather = createContextHandler(resolveConfig({}), { provider, retriever: retriever(), telemetryDirectory: telemetry });
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
