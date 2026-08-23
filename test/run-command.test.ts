import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveConfig } from "../src/config";
import { createRunHandler, resolveCommandEnvironment, resolveCommandShell, RUN_SUMMARY_MAX_BYTES, RUN_SUMMARY_TARGET_BYTES } from "../src/run-command";

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
      expect(await run({ workspaceRoot: process.cwd(), command: "true" })).toBe("PASS exit=0");
      expect(await run({ workspaceRoot: process.cwd(), command: "sh -c 'echo broken >&2; exit 2'" })).toBe("FAIL exit=2\nbroken\n");
      const files = await (await import("node:fs/promises")).readdir(path.join(telemetry, "invocations"));
      const stored = await readFile(path.join(telemetry, "invocations", files[0]!), "utf8");
      expect(stored).not.toContain('"stderr": "broken');
    } finally { await rm(telemetry, { recursive: true, force: true }); }
  });

  it("uses a provider only for large output and bounds provider failures", async () => {
    const config = resolveConfig({ output: { smallOutputBytes: 10 } });
    const request = { workspaceRoot: process.cwd(), command: "yes x | head -n 50" };
    let targetOutputBytes = 0; let maxOutputBytes = 0;
    const compressed = await createRunHandler(config, { provider: { summarize: async (summaryRequest) => {
      targetOutputBytes = summaryRequest.targetOutputBytes; maxOutputBytes = summaryRequest.maxOutputBytes;
      return { text: "tests pass total=50", durationMs: 2 };
    } } })(request);
    expect(compressed).toBe("PASS exit=0\ntests pass total=50");
    expect(targetOutputBytes).toBe(RUN_SUMMARY_TARGET_BYTES);
    expect(maxOutputBytes).toBeLessThanOrEqual(RUN_SUMMARY_MAX_BYTES);
    const output = await createRunHandler(config, { provider: { summarize: async () => { throw new Error("offline"); } }, resolveLimit: async () => 100 })(request);
    expect(output).toStartWith("PASS exit=0 provider-error\n");
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(320);
  });

  it("marks output truncated while preserving whole diagnostic lines", async () => {
    const config = resolveConfig({ output: { smallOutputBytes: 10 } });
    const output = await createRunHandler(config, {
      provider: { summarize: async () => ({ text: "diagnostic line\n".repeat(1_000), durationMs: 2 }) },
      resolveLimit: async () => 2_500,
    })({ workspaceRoot: process.cwd(), command: "yes x | head -n 50" });
    expect(output).toStartWith("PASS exit=0 truncated\n");
    expect(output).toEndWith("[additional diagnostics omitted to fit parent tool-output budget]");
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(8_000);
  });
});
