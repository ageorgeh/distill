import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assembleContextPacket } from "../src/context-packet";
import { codexContextManifestJsonSchema, contextManifestJsonSchema, parseContextManifest } from "../src/context-manifest";

describe("context manifests and packets", () => {
  it("derives JSON schema, validates manifests, reads exact excerpts, and merges ranges", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "distill-context-packet-"));
    try {
      await writeFile(path.join(root, "worker.ts"), "first\nsecond\nthird\nfourth\n", "utf8");
      const manifest = parseContextManifest({ summary: "Implement the compact contract.", notes: [{ kind: "requirement", text: "Keep the contract.", priority: 1 }, { kind: "workstream", text: "1. Update worker.", priority: 1 }, { kind: "risk", text: "Avoid stale work.", priority: 1 }], files: [{ path: "worker.ts", role: "edit", reason: "worker flow", ranges: [{ startLine: 1, endLine: 2 }, { startLine: 2, endLine: 3 }], priority: 1, includeExcerpt: true }], validation: ["bun test"], gaps: [] });
      const result = await assembleContextPacket({ id: "ctx_test", workspaceRoot: root, manifest, resultByteBudget: 8_000 });
      expect(contextManifestJsonSchema.type).toBe("object");
      expect(result.packet).toContain("CONTRACT\n- Keep the contract.");
      expect(result.packet).toContain("worker.ts:1-3\n1 | first\n2 | second\n3 | third");
      expect(result.packet).toContain("GAPS\nnone");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("turns invalid file evidence into visible gaps", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "distill-context-gaps-"));
    try {
      const manifest = parseContextManifest({ summary: "Task", notes: [], files: [{ path: "../outside.ts", role: "edit", reason: "bad", priority: 1, includeExcerpt: true }], validation: [], gaps: [] });
      const result = await assembleContextPacket({ id: "ctx_gap", workspaceRoot: root, manifest, resultByteBudget: 8_000 });
      expect(result.packet).toContain("GAPS\n- Missing or outside workspace: ../outside.ts");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("uses Codex-compatible strict JSON schema while accepting null optional output", () => {
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const schema = value as { type?: unknown; properties?: Record<string, unknown>; required?: unknown; additionalProperties?: unknown };
      if (schema.type === "object") {
        expect(schema.additionalProperties).toBe(false);
        expect(new Set(schema.required as string[])).toEqual(new Set(Object.keys(schema.properties ?? {})));
      }
      Object.values(schema).forEach(visit);
    };
    visit(codexContextManifestJsonSchema);
    expect(parseContextManifest({ summary: "ok", notes: [{ kind: "risk", text: "x", source: null, priority: 1 }], files: [], validation: [], gaps: [] }).notes[0]?.source).toBeUndefined();
  });
});
