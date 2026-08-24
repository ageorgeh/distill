import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { resolveConfig } from "../src/config";
import { createGortexContextProvider, gortexAttemptFromError } from "../src/gortex-context";
import type { GitChange } from "../src/git-context";

function fakeChild() {
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = () => true;
  return child;
}

function complete(child: ReturnType<typeof fakeChild>, output: string) {
  queueMicrotask(() => { child.stdout.end(output); child.exitCode = 0; child.emit("close", 0); });
}

function indexOutput(root: string, stale = false): string {
  return JSON.stringify([{ path: root, stale, head_commit: "head", indexed_commit: stale ? "old" : "head", last_indexed: "now" }]);
}

describe("Gortex context over-gather", () => {
  it("runs one generous TOON explore and always supplies bounded explicit files and documentation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "distill-gortex-"));
    try {
      await writeFile(path.join(root, "missing.ts"), "export function missing() {\n  return true;\n}\n", "utf8");
      await writeFile(path.join(root, "present.ts"), "export const present = true;\n", "utf8");
      await writeFile(path.join(root, "llms.txt"), "Repository architecture index.\n", "utf8");
      let executable = "";
      let args: string[] = [];
      let options: Record<string, unknown> = {};
      const config = resolveConfig({ context: { gortexCommand: "custom-gortex", gortexMaxSymbols: 100, gortexMaxOutputBytes: 200_000 } }).context;
      const provider = createGortexContextProvider(config, {
        spawn: ((command: string, processArgs: string[], processOptions: Record<string, unknown>) => {
          const child = fakeChild();
          if (processArgs[0] === "repos") { complete(child, indexOutput(root)); return child; }
          executable = command;
          args = processArgs;
          options = processOptions;
          complete(child, `relevant_symbols[1]:\n  - file_path: ${path.basename(root)}/present.ts\n    start_line: 12\n`);
          return child;
        }) as any,
      });

      const result = await provider.gather({
        action: "gather",
        workspaceRoot: root,
        intent: "implement",
        objective: "Fix queue behaviour.",
        references: ["missing.ts", "present.ts"],
        inlineEvidence: "ExactQueueFailure: candidate clientId missing",
      }, { documentationIndexes: ["llms.txt"], deterministicEvidence: "intent: merge-review\nmandatory_seed_files:\n- present.ts" });

      expect(executable).toBe("custom-gortex");
      expect(args).toEqual(expect.arrayContaining(["explore", "--index", root, "--format", "toon", "--max-symbols", "100", "--no-progress"]));
      expect(args[1]).toContain("Explicit retrieval references:\n- missing.ts\n- present.ts");
      expect(args[1]).toContain("Additional supplied evidence:\nExactQueueFailure: candidate clientId missing");
      expect(options).toMatchObject({ cwd: root, shell: false });
      expect(result.text).toContain("EXPLICIT REFERENCE SOURCE\nfile: missing.ts");
      expect(result.text).toContain("EXPLICIT REFERENCE SOURCE\nfile: present.ts");
      expect(result.text).toContain("DOCUMENTATION INDEX SOURCE\nfile: llms.txt");
      expect(result.text).toContain("DETERMINISTIC GIT EVIDENCE");
      expect(result.text).toContain("1 | export function missing()");
      expect(result.supplementedReferences).toEqual(["missing.ts", "present.ts"]);
      expect(result.documentationIndexes).toEqual(["llms.txt"]);
      expect(result.deterministicEvidenceBytes).toBeGreaterThan(0);
      expect(result.command).toEqual(["custom-gortex", ...args]);
      expect(result.status).toBe("complete");
      expect(result.indexStatus.status).toBe("fresh");
      expect(result.truncated).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("bounds oversized graph output while retaining its beginning and end", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "distill-gortex-bounded-"));
    try {
      const config = resolveConfig({ context: { gortexMaxOutputBytes: 2_000 } }).context;
      const provider = createGortexContextProvider(config, {
        spawn: ((_command: string, args: string[]) => {
          const child = fakeChild();
          complete(child, args[0] === "repos" ? indexOutput(root) : `BEGIN${"x".repeat(5_000)}END`);
          return child;
        }) as any,
      });
      const result = await provider.gather({ action: "gather", workspaceRoot: root, intent: "advise", objective: "Locate owners." });
      expect(result.truncated).toBe(true);
      expect(result.bytes).toBeLessThanOrEqual(2_000);
      expect(result.text).toContain("BEGIN");
      expect(result.text).toContain("END");
      expect(result.text).toContain("middle omitted");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("uses only a small high-confidence subset of changed files as graph seeds", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "distill-gortex-seeds-"));
    try {
      let task = "";
      const config = resolveConfig({ context: { gortexMaxOutputBytes: 200_000 } }).context;
      const provider = createGortexContextProvider(config, {
        spawn: ((_command: string, args: string[]) => {
          const child = fakeChild();
          if (args[0] === "repos") { complete(child, indexOutput(root)); return child; }
          task = args[1] ?? "";
          complete(child, "relevant_symbols[0]: []\n");
          return child;
        }) as any,
      });
      const gitChanges: GitChange[] = [
        ...Array.from({ length: 30 }, (_, index): GitChange => ({ path: `packages/modules/core/server/src/feature/owner-${index}.ts`, additions: index + 1, deletions: 0, sources: ["committed"] })),
        { path: "packages/modules/core/admin/tests/pdf-rendition.test.ts", additions: 20, deletions: 2, sources: ["working-tree"] },
        { path: "packages/modules/core/config/src/schema/pdf-rendition.ts", additions: 12, deletions: 1, sources: ["committed"] },
        { path: "packages/modules/base/docs/pdf-rendition.md", additions: 8, deletions: 0, sources: ["committed"] },
        { path: "packages/private/client/generated/content-types.manifest.json", additions: 2_000, deletions: 2_000, sources: ["committed"] },
      ];
      const result = await provider.gather({
        action: "gather",
        workspaceRoot: root,
        intent: "merge-review",
        objective: "Review PDF rendition server ownership and contracts.",
        references: ["task-105"],
      }, { gitChanges, deterministicEvidence: `mandatory_seed_files:\n${gitChanges.map((change) => `- ${change.path}`).join("\n")}` });

      expect(result.gitReferenceCount).toBe(gitChanges.length);
      expect(result.selectedGitReferences.length).toBeLessThanOrEqual(6);
      expect(result.selectedGitReferences).toContain("packages/modules/core/admin/tests/pdf-rendition.test.ts");
      expect(result.selectedGitReferences).toContain("packages/modules/core/config/src/schema/pdf-rendition.ts");
      expect(task).toContain("Explicit retrieval references:\n- task-105");
      expect(task).toContain("Representative changed-file graph seeds:");
      expect(task).not.toContain("Changed-area digest");
      expect(task).not.toContain("owner-29.ts");
      expect(task).not.toContain("packages/private/client/generated/content-types.manifest.json");
      expect(result.text).toContain("mandatory_seed_files:");
      expect(result.gitSeedDecisions.filter((decision) => decision.selected).length).toBeLessThanOrEqual(6);
      expect(result.gitSeedDecisions.some((decision) => !decision.selected && decision.reason.includes("never inferred"))).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("degrades to deterministic evidence and requests graceful interruption on timeout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "distill-gortex-timeout-"));
    try {
      const signals: Array<NodeJS.Signals | number | undefined> = [];
      const config = resolveConfig({ context: { gortexTimeoutMs: 5 } }).context;
      const provider = createGortexContextProvider(config, {
        spawn: ((_command: string, args: string[]) => {
          const child = fakeChild();
          if (args[0] === "repos") { complete(child, indexOutput(root)); return child; }
          child.kill = (signal?: NodeJS.Signals | number) => { signals.push(signal); return true; };
          return child;
        }) as any,
      });
      const result = await provider.gather({ action: "gather", workspaceRoot: root, intent: "advise", objective: "Locate the owner." }, { deterministicEvidence: "mandatory_seed_files:\n- owner.ts" });
      expect(result.status).toBe("degraded");
      expect(result.failure).toContain("Gortex may continue daemon-side work");
      expect(result.text).toContain("GRAPH RETRIEVAL DEGRADED");
      expect(result.text).toContain("mandatory_seed_files:");
      expect(signals[0]).toBe("SIGINT");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("still aborts when the caller cancels graph retrieval", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "distill-gortex-cancel-"));
    try {
      const provider = createGortexContextProvider(resolveConfig({}).context, {
        spawn: ((_command: string, args: string[]) => {
          const child = fakeChild();
          if (args[0] === "repos") { complete(child, indexOutput(root)); return child; }
          return child;
        }) as any,
      });
      const controller = new AbortController();
      const pending = provider.gather({ action: "gather", workspaceRoot: root, intent: "advise", objective: "Locate the owner." }, { signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.abort();
      let failure: unknown;
      try { await pending; } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("cancelled");
      expect(gortexAttemptFromError(failure)).toMatchObject({ explicitReferenceCount: 0, selectedGitReferences: [] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("marks successful graph output degraded when the tracked index is stale", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "distill-gortex-stale-"));
    try {
      const provider = createGortexContextProvider(resolveConfig({}).context, {
        spawn: ((_command: string, args: string[]) => {
          const child = fakeChild();
          complete(child, args[0] === "repos" ? indexOutput(root, true) : "relevant_symbols[0]: []\n");
          return child;
        }) as any,
      });
      const result = await provider.gather({ action: "gather", workspaceRoot: root, intent: "advise", objective: "Locate the owner." });
      expect(result.status).toBe("degraded");
      expect(result.indexStatus).toMatchObject({ status: "stale", headCommit: "head", indexedCommit: "old" });
      expect(result.text).toContain("Gortex index is stale");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
