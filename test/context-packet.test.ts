import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildContextBundle } from "../src/context-packet";
import { codexContextManifestJsonSchema, contextManifestJsonSchema, parseContextManifest } from "../src/context-manifest";

const manifest = (count = 2) => parseContextManifest({
  scope: "Context handoff ownership.", globalFindings: [{ text: "Generated packages are release-owned.", priority: 1 }], globalFiles: [], globalSearchesCompleted: [{ query: "context", scope: "src", result: "Handlers are in src/context.ts.", priority: 1 }], globalValidation: ["pnpm run verify"], globalGaps: [],
  concerns: Array.from({ length: count }, (_, index) => ({ id: `concern-${index + 1}`, title: `Concern ${index + 1}`, summary: `Current ownership for concern ${index + 1}.`, priority: index === 0 ? 1 : 2, dependencies: index ? ["concern-1"] : [], findings: [{ text: `Finding ${index + 1}.`, priority: 1 }], files: [{ path: "worker.ts", role: "edit", inspected: true, relevance: "Implementation owner.", priority: 1, observations: [{ text: "Reads exact source.", startLine: 1, endLine: 2 }], excerpts: [{ startLine: 1, endLine: 3, reason: "Core flow." }] }], searchesCompleted: [{ query: `symbol-${index + 1}`, result: "One owner found.", priority: 1 }], validation: ["bun test"], gaps: [] })),
});

describe("context manifests and packet bundles", () => {
  it("derives strict schema and creates complete bounded semantic packets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "distill-context-packet-"));
    try {
      await writeFile(path.join(root, "worker.ts"), "first\nsecond\nthird\nfourth\n", "utf8");
      const result = await buildContextBundle({ contextId: "123e4567-e89b-12d3-a456-426614174000", workspaceRoot: root, manifest: manifest(8), resultByteBudget: 1_400 });
      expect(contextManifestJsonSchema.type).toBe("object");
      expect(result.bundle.packets.find((packet) => packet.id === "index-1")?.text).toContain("repository pass complete");
      expect(result.bundle.packets.filter((packet) => packet.concernId).map((packet) => packet.concernId)).toContain("concern-8");
      expect(result.bundle.packets.every((packet) => packet.bytes <= 1_400)).toBe(true);
      const ids = result.bundle.packets.flatMap((packet) => packet.blockIds);
      expect(new Set(ids).size).toBe(ids.length);
      expect(result.bundle.packets.some((packet) => packet.text.includes("worker.ts:1-3"))).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("normalizes duplicate files and invalid ranges without technical task gaps", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "distill-context-normalize-"));
    try {
      await writeFile(path.join(root, "worker.ts"), "one\ntwo\n", "utf8");
      const input = manifest(1); input.concerns[0]!.files.push({ path: "worker.ts", role: "documentation", inspected: true, relevance: "Additional context.", priority: 3, observations: [{ text: "Tail evidence.", startLine: 2, endLine: 99 }], excerpts: [{ startLine: 99, endLine: 100, reason: "bad" }] });
      const result = await buildContextBundle({ contextId: "123e4567-e89b-12d3-a456-426614174001", workspaceRoot: root, manifest: input, resultByteBudget: 8_000 });
      expect(result.normalization.some((entry) => entry.includes("Dropped invalid excerpt"))).toBe(true);
      expect(result.bundle.manifest.concerns[0]!.files).toHaveLength(1);
      expect(result.bundle.manifest.concerns[0]!.files[0]!.role).toBe("edit");
      expect(result.bundle.packets.every((packet) => !packet.text.includes("Dropped invalid"))).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("uses Codex-compatible strict JSON schema and rejects invalid concern graphs", () => {
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const schema = value as { type?: unknown; properties?: Record<string, unknown>; required?: unknown; additionalProperties?: unknown };
      if (schema.type === "object") { expect(schema.additionalProperties).toBe(false); expect(new Set(schema.required as string[])).toEqual(new Set(Object.keys(schema.properties ?? {}))); }
      Object.values(schema).forEach(visit);
    };
    visit(codexContextManifestJsonSchema);
    expect(() => parseContextManifest({ ...manifest(1), concerns: [{ ...manifest(1).concerns[0]!, dependencies: ["missing"] }] })).toThrow("missing concern");
  });
});
