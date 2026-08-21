import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_PARENT_TOOL_OUTPUT_LIMIT, parseCommand, resolveConfig } from "../src/config";
import { resolveToolOutputTokenLimit, resultBudget } from "../src/codex-config";
import { readRepositoryConfig } from "../src/repo-config";
import { resolveTelemetryDirectory } from "../src/telemetry";
import { CONTEXT_DESCRIPTION, CONTEXT_SCHEMA } from "../src/mcp";

describe("new configuration", () => {
  it("resolves separate output and context settings", () => {
    const config = resolveConfig({ output: { provider: "external", model: "small", host: "http://example.test/" }, context: { model: "spark", gortexCommand: "custom-gortex", gortexMaxSymbols: 120, gortexMaxOutputBytes: 180_000 } });
    expect(config.output).toMatchObject({ provider: "external", model: "small", host: "http://example.test" });
    expect(config.context).toMatchObject({ provider: "codex", model: "spark", gortexCommand: "custom-gortex", gortexMaxSymbols: 120, gortexMaxOutputBytes: 180_000, gortexTimeoutMs: 60_000 });
  });

  it("defines context intents by operation and recommends remote review bases", () => {
    expect(CONTEXT_DESCRIPTION).toContain("advise for read-only investigation");
    expect(CONTEXT_DESCRIPTION).toContain("review only when the actual base-to-HEAD branch or PR changeset is the subject");
    expect(CONTEXT_SCHEMA.properties.intent.description).toContain("Choose implement when code or configuration will change");
    expect(CONTEXT_SCHEMA.properties.baseRef.description).toContain("origin/dev");
    expect(CONTEXT_SCHEMA.properties.baseRef.description).toContain("does not fetch remotes");
  });

  it("parses the new CLI commands", () => {
    expect(parseCommand(["run", "status", "--", "pnpm", "lint"], "/repo")).toMatchObject({ kind: "run", request: { workspaceRoot: "/repo" } });
    expect(parseCommand(["context", "gather", "--intent", "review", "--reference", "task-083", "--reference", "src/a.ts", "--base-ref", "dev", "Gather evidence"], "/repo")).toEqual({ kind: "context", request: { action: "gather", workspaceRoot: "/repo", intent: "review", objective: "Gather evidence", references: ["task-083", "src/a.ts"], baseRef: "dev" } });
    expect(() => parseCommand(["context", "packet", "123e4567-e89b-12d3-a456-426614174000", "owner-1"], "/repo")).toThrow("Usage: distill context gather");
  });

  it("reads only the top-level Codex limit and small repository TOML", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "distill-config-"));
    try {
      await writeFile(path.join(root, "config.toml"), "tool_output_token_limit = 2000\n[profile.x]\ntool_output_token_limit = 9999\n");
      expect(await resolveToolOutputTokenLimit({ CODEX_HOME: root }, root)).toEqual({ limit: 2000, source: "codex-home", configPath: path.join(root, "config.toml") });
      expect(resultBudget({ limit: 2000, source: "default" })).toEqual({ resultTokenBudget: 1600, resultByteBudget: 6400 });
      await (await import("node:fs/promises")).mkdir(path.join(root, ".distill"));
      await writeFile(path.join(root, ".distill", "config.toml"), "[context]\ndocumentation_indexes = [\"docs/llms.txt\"]\ndefault_base = \"origin/dev\"\n");
      expect(await readRepositoryConfig(root)).toEqual({ documentationIndexes: ["docs/llms.txt"], defaultBase: "origin/dev" });
      expect(await resolveToolOutputTokenLimit({ CODEX_HOME: path.join(root, "missing") }, path.join(root, "missing-home"))).toEqual({ limit: DEFAULT_PARENT_TOOL_OUTPUT_LIMIT, source: "default" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("anchors relative telemetry under the Distill installation root", () => {
    expect(resolveTelemetryDirectory(".telemetry", "/tmp/distill-telemetry")).toBe("/tmp/distill-telemetry");
  });
});
