import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_PARENT_TOOL_OUTPUT_LIMIT, parseCommand, resolveConfig } from "../src/config";
import { resolveToolOutputTokenLimit, resultBudget } from "../src/codex-config";
import { readRepositoryConfig } from "../src/repo-config";
import { resolveTelemetryDirectory } from "../src/telemetry";

describe("new configuration", () => {
  it("resolves separate output and context settings", () => {
    const config = resolveConfig({ output: { provider: "external", model: "small", host: "http://example.test/" }, context: { model: "spark", childToolOutputTokenLimit: 9000 } });
    expect(config.output).toMatchObject({ provider: "external", model: "small", host: "http://example.test" });
    expect(config.context).toMatchObject({ provider: "codex", model: "spark", childToolOutputTokenLimit: 9000 });
  });

  it("parses the new CLI commands", () => {
    expect(parseCommand(["run", "status", "--", "pnpm", "lint"], "/repo")).toMatchObject({ kind: "run", request: { workspaceRoot: "/repo" } });
    expect(parseCommand(["context", "--intent", "review", "--reference", "task-083", "--reference", "src/a.ts", "--base-ref", "dev", "Gather evidence"], "/repo")).toEqual({ kind: "context", request: { workspaceRoot: "/repo", intent: "review", objective: "Gather evidence", references: ["task-083", "src/a.ts"], baseRef: "dev" } });
  });

  it("reads only the top-level Codex limit and small repository TOML", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "distill-config-"));
    try {
      await writeFile(path.join(root, "config.toml"), "tool_output_token_limit = 2000\n[profile.x]\ntool_output_token_limit = 9999\n");
      expect(await resolveToolOutputTokenLimit({ CODEX_HOME: root })).toBe(2000);
      expect(resultBudget(2000)).toEqual({ resultTokenBudget: 1600, resultByteBudget: 6400 });
      await (await import("node:fs/promises")).mkdir(path.join(root, ".distill"));
      await writeFile(path.join(root, ".distill", "config.toml"), "[context]\ndocumentation_indexes = [\"docs/llms.txt\"]\ndefault_base = \"dev\"\n");
      expect(await readRepositoryConfig(root)).toEqual({ documentationIndexes: ["docs/llms.txt"], defaultBase: "dev" });
      expect(await resolveToolOutputTokenLimit({ CODEX_HOME: path.join(root, "missing") })).toBe(DEFAULT_PARENT_TOOL_OUTPUT_LIMIT);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("anchors relative telemetry under the Distill installation root", () => {
    expect(resolveTelemetryDirectory(".telemetry", "/tmp/distill-telemetry")).toBe("/tmp/distill-telemetry");
  });
});
