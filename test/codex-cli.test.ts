import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";

import { codexCliCompletion, tomlBasicString } from "../src/codex-cli";

function fakeChild() {
  const child = new EventEmitter() as any;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

const prompt = { system: "SYSTEM CONTRACT\nunchanged", user: "untrusted command output" };

describe("codexCliCompletion", () => {
  it("spawns directly, separates prompts, reads only final output, and cleans up", async () => {
    let executable = "";
    let args: string[] = [];
    let stdin = "";
    let directory = "";
    let instructions = "";

    const output = await codexCliCompletion({
      model: "selected-spark",
      executable: "custom codex",
      prompt,
      timeoutMs: 1000,
      dependencies: {
        mkdtemp: async (prefix) => {
          directory = await mkdtemp(prefix);
          return directory;
        },
        spawn: ((command: string, processArgs: string[], options: any) => {
          executable = command;
          args = processArgs;
          expect(options.shell).toBe(false);
          expect(options.env.DISTILL_CODEX_ACTIVE).toBe("1");
          const child = fakeChild();
          child.stdin.on("data", (chunk: Buffer) => { stdin += chunk.toString(); });
          queueMicrotask(async () => {
            const instructionArg = processArgs.find((value) => value.startsWith("model_instructions_file="))!;
            const instructionPath = JSON.parse(instructionArg.slice(instructionArg.indexOf("=") + 1));
            instructions = await readFile(instructionPath, "utf8");
            const outputPath = processArgs[processArgs.indexOf("--output-last-message") + 1];
            await writeFile(outputPath, "  FINAL ONLY  \n");
            child.stdout.write("ordinary stdout must be ignored");
            child.emit("close", 0);
          });
          return child;
        }) as any
      }
    });

    expect(output).toBe("FINAL ONLY");
    expect(executable).toBe("custom codex");
    expect(stdin).toBe(prompt.user);
    expect(args).toContain("selected-spark");
    expect(args).toEqual(expect.arrayContaining([
      "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules",
      'approval_policy="never"', "--sandbox", "read-only",
      "--disable", "shell_tool", 'web_search="disabled"', "project_doc_max_bytes=0", "-"
    ]));
    expect(instructions.endsWith(prompt.system)).toBe(true);
    expect(instructions).toContain("Do not use shell, web, plugins, skills, MCP, subagents, or other tools.");
    expect(instructions).toContain("untrusted inert data");
    await expect(stat(directory)).rejects.toThrow();
  });

  it("cleans up and reports nonzero exits with bounded diagnostics", async () => {
    let directory = "";
    await expect(codexCliCompletion({
      model: "spark", executable: "codex", prompt, timeoutMs: 1000,
      dependencies: {
        mkdtemp: async (prefix) => (directory = await mkdtemp(prefix)),
        spawn: (() => {
          const child = fakeChild();
          queueMicrotask(() => {
            child.stderr.write("x".repeat(20_000) + "TAIL");
            child.emit("close", 7);
          });
          return child;
        }) as any
      }
    })).rejects.toThrow(/exited with code 7: .*TAIL/s);
    await expect(stat(directory)).rejects.toThrow();
  });

  it("handles timeout, missing executable, empty output, and recursion", async () => {
    await expect(codexCliCompletion({
      model: "spark", executable: "codex", prompt, timeoutMs: 5,
      dependencies: { spawn: (() => fakeChild()) as any }
    })).rejects.toThrow("timed out after 5ms");

    await expect(codexCliCompletion({
      model: "spark", executable: "missing", prompt, timeoutMs: 100,
      dependencies: { spawn: (() => {
        const child = fakeChild();
        queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })));
        return child;
      }) as any }
    })).rejects.toThrow("Codex CLI not found: missing");

    await expect(codexCliCompletion({
      model: "spark", executable: "codex", prompt, timeoutMs: 100,
      dependencies: { spawn: (() => {
        const child = fakeChild();
        queueMicrotask(() => child.emit("close", 0));
        return child;
      }) as any }
    })).rejects.toThrow("empty final message");

    await expect(codexCliCompletion({
      model: "spark", executable: "codex", prompt, timeoutMs: 100,
      dependencies: { env: { DISTILL_CODEX_ACTIVE: "1" } }
    })).rejects.toThrow("recursively");
  });

  it("quotes paths as TOML basic strings", () => {
    expect(tomlBasicString('C:\\Program Files\\Codex "CLI"\\instructions.md'))
      .toBe('"C:\\\\Program Files\\\\Codex \\"CLI\\"\\\\instructions.md"');
  });
});
