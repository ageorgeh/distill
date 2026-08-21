import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { resolveConfig } from "../src/config";
import { createGortexContextProvider } from "../src/gortex-context";

function fakeChild() {
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
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
          executable = command;
          args = processArgs;
          options = processOptions;
          const child = fakeChild();
          queueMicrotask(() => {
            child.stdout.end(`relevant_symbols[1]:\n  - file_path: ${path.basename(root)}/present.ts\n    start_line: 12\n`);
            child.emit("close", 0);
          });
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
      }, { documentationIndexes: ["llms.txt"], deterministicEvidence: "intent: review\nmandatory_seed_files:\n- present.ts" });

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
      expect(result.truncated).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("bounds oversized graph output while retaining its beginning and end", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "distill-gortex-bounded-"));
    try {
      const config = resolveConfig({ context: { gortexMaxOutputBytes: 2_000 } }).context;
      const provider = createGortexContextProvider(config, {
        spawn: (() => {
          const child = fakeChild();
          queueMicrotask(() => {
            child.stdout.end(`BEGIN${"x".repeat(5_000)}END`);
            child.emit("close", 0);
          });
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
});
