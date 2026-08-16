import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveConfig } from "../src/config";
import { createRunHandler, resolveCommandEnvironment, resolveCommandShell } from "../src/run-command";

describe("run", () => {
  it("uses a login shell while preserving the complete inherited environment", async () => {
    expect(resolveCommandShell("printf ok", { SHELL: "/bin/bash" }, "linux")).toEqual({
      executable: "/bin/bash",
      args: ["-l", "-c", "printf ok"],
    });
    expect(resolveCommandShell("echo ok", { ComSpec: "C:\\Windows\\System32\\cmd.exe" }, "win32")).toEqual({
      executable: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "echo ok"],
    });
    expect(resolveCommandEnvironment({ KEEP: "yes", __NIXOS_SET_ENVIRONMENT_DONE: "1" }, "linux")).toEqual({ KEEP: "yes" });
    expect(resolveCommandEnvironment({ KEEP: "yes", __NIXOS_SET_ENVIRONMENT_DONE: "1" }, "win32")).toEqual({
      KEEP: "yes",
      __NIXOS_SET_ENVIRONMENT_DONE: "1",
    });

    const key = "DISTILL_INHERITED_ENV_TEST";
    const previous = process.env[key];
    process.env[key] = "available-to-child";
    try {
      const telemetry = await mkdtemp(path.join(tmpdir(), "distill-run-env-"));
      try {
        const run = createRunHandler(resolveConfig({}), { telemetryDirectory: telemetry });
        expect(await run({ workspaceRoot: process.cwd(), command: `printf '%s' "$${key}"` })).toContain("available-to-child");
      } finally { await rm(telemetry, { recursive: true, force: true }); }
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  it("reports silent commands and returns small output directly", async () => {
    const telemetry = await mkdtemp(path.join(tmpdir(), "distill-run-telemetry-"));
    try {
      const run = createRunHandler(resolveConfig({}), { telemetryDirectory: telemetry });
      expect(await run({ workspaceRoot: process.cwd(), command: "true" })).toBe("COMMAND PASS exit=0 output=empty");
      expect(await run({ workspaceRoot: process.cwd(), command: "sh -c 'echo broken >&2; exit 2'" })).toBe("COMMAND FAIL exit=2 distilled=no reason=small-output\nbroken\n");
      const files = await (await import("node:fs/promises")).readdir(path.join(telemetry, "invocations"));
      const stored = await readFile(path.join(telemetry, "invocations", files[0]!), "utf8");
      expect(stored).not.toContain('"stderr": "broken');
    } finally { await rm(telemetry, { recursive: true, force: true }); }
  });

  it("uses a provider only for large output and bounds provider failures", async () => {
    const config = resolveConfig({ output: { smallOutputBytes: 10 } });
    const request = { workspaceRoot: process.cwd(), command: "yes x | head -n 50" };
    expect(await createRunHandler(config, { provider: { summarize: async () => ({ text: "compressed", durationMs: 2 }) } })(request)).toContain("distilled=yes\ncompressed");
    const output = await createRunHandler(config, { provider: { summarize: async () => { throw new Error("offline"); } }, resolveLimit: async () => 100 })(request);
    expect(output).toContain("reason=provider-error");
    expect(Buffer.byteLength(output)).toBeLessThan(320);
  });
});
