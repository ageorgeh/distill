import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { codexContextManifestJsonSchema, contextManifestJsonSchema, parseContextManifest, type ContextManifest } from "../src/context-manifest";
import { buildContextSourcePack } from "../src/context-source-pack";

function manifest(files: ContextManifest["files"]): ContextManifest {
  return parseContextManifest({
    files,
    searchesCompleted: [{ query: "worker", scope: "src", matches: ["worker.ts:1 — implementation owner"] }],
    validation: ["bun test"],
  });
}

const owner = (file = "worker.ts", excerpts = [{ startLine: 1, endLine: 3, reason: "Core flow." }]): ContextManifest["files"][number] => ({
  path: file, role: "edit", relevance: "Direct implementation owner.", priority: 1, excerpts,
});

describe("flat context source packs", () => {
  it("returns one deduplicated source bundle with exact verified source", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "distill-source-pack-"));
    try {
      await writeFile(path.join(root, "worker.ts"), "first\nsecond\nthird\nfourth\n", "utf8");
      const input = manifest([owner(), { ...owner(), role: "documentation", relevance: "Duplicate supporting entry.", priority: 3, excerpts: [{ startLine: 2, endLine: 4, reason: "Adjacent flow." }] }]);
      const result = await buildContextSourcePack({ contextId: "123e4567-e89b-12d3-a456-426614174000", workspaceRoot: root, manifest: input, resultByteBudget: 40_000 });
      expect(contextManifestJsonSchema.type).toBe("object");
      expect(result.text).toContain("Repository discovery and initial source reading are complete");
      expect(result.text).toContain("EXACT SOURCE\nworker.ts:1-4");
      expect(result.text).toContain("1 | first");
      expect(result.manifest.files).toHaveLength(1);
      expect(result.manifest.files[0]!.role).toBe("edit");
      expect(result.bytes).toBeLessThanOrEqual(40_000);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("normalizes the repository-label prefix emitted by Gortex", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "distill-source-label-"));
    try {
      await writeFile(path.join(root, "worker.ts"), "first\nsecond\n", "utf8");
      const result = await buildContextSourcePack({
        contextId: "123e4567-e89b-12d3-a456-426614174010",
        workspaceRoot: root,
        manifest: manifest([owner(`${path.basename(root)}/worker.ts`, [{ startLine: 1, endLine: 2, reason: "Labelled owner." }])]),
        resultByteBudget: 40_000,
      });
      expect(result.manifest.files[0]?.path).toBe("worker.ts");
      expect(result.text).toContain("EXACT SOURCE\nworker.ts:1-2");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("splits broad excerpts into exact source chunks instead of dropping them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "distill-source-split-"));
    try {
      await writeFile(path.join(root, "worker.ts"), Array.from({ length: 260 }, (_, index) => `line ${index + 1}`).join("\n"), "utf8");
      const input = manifest([owner("worker.ts", [{ startLine: 1, endLine: 260, reason: "Complete implementation region." }])]);
      const result = await buildContextSourcePack({ contextId: "123e4567-e89b-12d3-a456-426614174001", workspaceRoot: root, manifest: input, resultByteBudget: 40_000 });
      expect(result.normalization).toContain("Split broad excerpt in worker.ts:1-260");
      expect(result.includedSources).toEqual(["worker.ts:1-80", "worker.ts:81-160", "worker.ts:161-240", "worker.ts:241-260"]);
      expect(result.text).toContain("260 | line 260");
      expect(result.omittedSources).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("uses the larger one-response budget for broad tasks and covers every direct owner first", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "distill-source-broad-"));
    try {
      const files = Array.from({ length: 8 }, (_, index) => owner(`owner-${index + 1}.ts`, [{ startLine: 1, endLine: 12, reason: `Owner ${index + 1}.` }]));
      await Promise.all(files.map((file, index) => writeFile(path.join(root, file.path), Array.from({ length: 12 }, (_, line) => `export const value${index}_${line} = ${line};`).join("\n"), "utf8")));
      const result = await buildContextSourcePack({ contextId: "123e4567-e89b-12d3-a456-426614174002", workspaceRoot: root, manifest: manifest(files), resultByteBudget: 80_000 });
      expect(result.broad).toBe(true);
      for (const file of files) expect(result.text).toContain(`EXACT SOURCE\n${file.path}:1-12`);
      expect(result.bytes).toBeGreaterThan(result.targetByteBudget / 10);
      expect(result.bytes).toBeLessThanOrEqual(result.hardByteBudget);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("degrades to precise additional locations without exceeding the single-result budget", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "distill-source-bounded-"));
    try {
      await writeFile(path.join(root, "worker.ts"), Array.from({ length: 80 }, (_, index) => `${index + 1} ${"x".repeat(160)}`).join("\n"), "utf8");
      const result = await buildContextSourcePack({ contextId: "123e4567-e89b-12d3-a456-426614174003", workspaceRoot: root, manifest: manifest([owner("worker.ts", [{ startLine: 1, endLine: 80, reason: "Byte-heavy implementation." }])]), resultByteBudget: 4_000 });
      expect(result.bytes).toBeLessThanOrEqual(4_000);
      expect(result.omittedSources).toEqual(["worker.ts:1-80"]);
      expect(result.text).toContain("FILES LOCATED");
      expect(result.text).toContain("worker.ts");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("uses a Codex-compatible strict JSON schema", () => {
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const schema = value as { type?: unknown; properties?: Record<string, unknown>; required?: unknown; additionalProperties?: unknown };
      if (schema.type === "object") { expect(schema.additionalProperties).toBe(false); expect(new Set(schema.required as string[])).toEqual(new Set(Object.keys(schema.properties ?? {}))); }
      Object.values(schema).forEach(visit);
    };
    visit(codexContextManifestJsonSchema);
  });
});
