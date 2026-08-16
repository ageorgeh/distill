import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveConfig } from "../src/config";
import { createRunHandler } from "../src/run-command";

describe("run", () => {
  it("reports silent commands and returns small output directly", async () => {
    const telemetry = await mkdtemp(path.join(tmpdir(), "distill-run-telemetry-"));
    try {
      const run = createRunHandler(resolveConfig({}), { telemetryDirectory: telemetry });
      expect(await run({ workspaceRoot: process.cwd(), command: "true" })).toBe("COMMAND PASS exit=0 output=empty");
      expect(await run({ workspaceRoot: process.cwd(), command: "sh -c 'echo broken >&2; exit 2'" })).toBe("COMMAND FAIL exit=2 distilled=no reason=small-output\nbroken\n");
      const files = await (await import("node:fs/promises")).readdir(telemetry);
      const stored = await readFile(path.join(telemetry, files[0]!), "utf8");
      expect(stored).not.toContain('"stderr": "broken');
    } finally { await rm(telemetry, { recursive: true, force: true }); }
  });

  it("uses a provider only for large output and bounds provider failures", async () => {
    const config = resolveConfig({ output: { smallOutputBytes: 10 } });
    const request = { workspaceRoot: process.cwd(), command: "yes x | head -n 50" };
    expect(await createRunHandler(config, { provider: { summarize: async () => "compressed" } })(request)).toContain("distilled=yes\ncompressed");
    const output = await createRunHandler(config, { provider: { summarize: async () => { throw new Error("offline"); } }, resolveLimit: async () => 20 })(request);
    expect(output).toContain("reason=provider-error");
    expect(Buffer.byteLength(output)).toBeLessThan(200);
  });
});
