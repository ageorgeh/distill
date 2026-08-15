import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import cliPackage from "../packages/cli/package.json";
import { createScriptCommand } from "./script-command";

const root = path.resolve(import.meta.dir, "..");
const cli = path.join(root, "src", "cli.ts");
const itUnixOnly = process.platform === "win32" ? it.skip : it;

describe("cli entrypoint", () => {
  it("prints help", () => {
    const result = spawnSync("bun", ["run", cli, "--help"], {
      cwd: root,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('cmd 2>&1 | distill "question"');
    expect(result.stdout).toContain("distill.config.ts");
  });

  it("prints the version", () => {
    const result = spawnSync("bun", ["run", cli, "--version"], {
      cwd: root,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(cliPackage.version);
  });

  it("reads provider settings from distill.config.ts and keeps debug as an action flag", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "distill-cli-config-"));

    try {
      await writeFile(
        path.join(dir, "distill.config.ts"),
        'export default { provider: "codex", codexModel: "debug-model", codexCommand: "distill-test-missing-codex-command" };\n',
      );

      const result = spawnSync(
        "bun",
        ["run", cli, "--debug", "summarize"],
        {
          cwd: dir,
          encoding: "utf8",
          input: "raw command output\n",
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("raw command output\n");
      expect(result.stderr).toContain("distill: debug: runtime");
      expect(result.stderr).toContain('provider=codex model="debug-model"');
      expect(result.stderr).toContain('command="distill-test-missing-codex-command"');
      expect(result.stderr).toContain("fallback=batch_error");
      expect(result.stderr).not.toContain("apiKey");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails on unsupported platforms", () => {
    const launcher = JSON.stringify(path.join(root, "packages", "cli", "bin", "distill.js"));
    const result = spawnSync(
      "node",
      [
        "-e",
        `Object.defineProperty(process, "platform", { value: "haiku" }); Object.defineProperty(process, "arch", { value: "x64" }); require(${launcher});`,
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[distill] Unsupported platform: haiku/x64.");
  });

  itUnixOnly("fails without stdin when attached to a tty", () => {
    const scriptCommand = createScriptCommand("/dev/null", "bun", [
      "run",
      cli,
      "is this safe?",
    ]);
    const result = spawnSync(scriptCommand.command, scriptCommand.args, {
      cwd: root,
      encoding: "utf8",
    });

    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain("stdin is required.");
  });
});
