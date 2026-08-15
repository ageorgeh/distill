import {
  beforeAll,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";
import { readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import cliPackage from "../packages/cli/package.json";
import { DEFAULT_MODEL } from "../src/config";
import {
  getCurrentPlatformKey,
  getPlatformTarget,
} from "../scripts/platform-targets";

setDefaultTimeout(process.platform === "win32" ? 120_000 : 60_000);

const root = path.resolve(import.meta.dir, "..");
const launcher = path.join(root, "packages", "cli", "bin", "distill.js");
const packageManagerCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const currentPlatformPackage = getPlatformTarget(getCurrentPlatformKey())?.packageName;

if (!currentPlatformPackage) {
  throw new Error(`Unsupported platform for e2e tests: ${getCurrentPlatformKey()}`);
}

interface InputStep {
  afterMs?: number;
  data: string;
}

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createProject(config: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "distill-e2e-project-"));
  await writeFile(path.join(dir, "distill.config.ts"), `export default ${JSON.stringify(config)};\n`);
  return dir;
}

async function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; inputSteps?: InputStep[]; env?: NodeJS.ProcessEnv },
): Promise<RunResult> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  for (const step of options.inputSteps ?? []) {
    await delay(step.afterMs ?? 0);
    if (!child.stdin.destroyed && !child.killed) {
      child.stdin.write(step.data);
    }
  }

  if (!child.stdin.destroyed && !child.killed) {
    child.stdin.end();
  }

  return new Promise<RunResult>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function runLauncher(
  cwd: string,
  args: string[],
  inputSteps?: InputStep[],
): Promise<RunResult> {
  return runProcess("node", [launcher, ...args], { cwd, inputSteps });
}

async function createFakeChatProvider(
  responder: (body: Record<string, unknown>, index: number) => Response | Promise<Response>,
): Promise<{
  host: string;
  requests: Array<Record<string, unknown>>;
  stop: () => void;
}> {
  const requests: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/chat/completions") {
        return new Response("not found", { status: 404 });
      }
      const payload = (await request.json()) as Record<string, unknown>;
      requests.push(payload);
      return responder(payload, requests.length - 1);
    },
  });

  return {
    host: `http://127.0.0.1:${server.port}/v1`,
    requests,
    stop: () => server.stop(true),
  };
}

beforeAll(() => {
  const result = Bun.spawnSync([packageManagerCommand, "run", "build"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error("Build failed before e2e tests.");
  }
});

describe("distill end-to-end", () => {
  it("summarizes batch output using settings from distill.config.ts", async () => {
    const fake = await createFakeChatProvider(() =>
      new Response(JSON.stringify({ choices: [{ message: { content: "All tests passed." } }] }), { status: 200 }),
    );
    const dir = await createProject({ provider: "external", host: fake.host });

    try {
      const result = await runLauncher(dir, ["did the tests pass?"], [{ data: "12 passed\n" }]);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("All tests passed.\n");
      expect(result.stderr).toBe("");
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0]).toMatchObject({ model: DEFAULT_MODEL });
    } finally {
      fake.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("translates output without requiring stdin", async () => {
    const fake = await createFakeChatProvider(() =>
      new Response(JSON.stringify({ choices: [{ message: { content: "Done." } }] }), { status: 200 }),
    );
    const dir = await createProject({ provider: "external", host: fake.host });

    try {
      const result = await runLauncher(dir, ["translate", "PASS tests pass", "en-US"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("Done.\n");
      expect(fake.requests).toHaveLength(1);
    } finally {
      fake.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to raw input when the configured provider is unavailable", async () => {
    const dir = await createProject({ provider: "external", host: "http://127.0.0.1:9/v1", timeoutMs: 150 });

    try {
      const result = await runLauncher(dir, ["summarize briefly"], [{ data: "fallback payload\n" }]);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("fallback payload\n");
      expect(result.stderr).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("passes through interactive prompts without calling the provider", async () => {
    const fake = await createFakeChatProvider(() =>
      new Response(JSON.stringify({ choices: [{ message: { content: "should not happen" } }] }), { status: 200 }),
    );
    const dir = await createProject({ provider: "external", host: fake.host });

    try {
      const result = await runLauncher(dir, ["confirm the action"], [
        { data: "Continue? [y/N]" },
        { afterMs: 1_000, data: "\ny\n" },
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("Continue? [y/N]\ny\n");
      expect(fake.requests).toHaveLength(0);
    } finally {
      fake.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("works after packing and installing the package locally", async () => {
    const fake = await createFakeChatProvider(() =>
      new Response(JSON.stringify({ choices: [{ message: { content: "Tests passed." } }] }), { status: 200 }),
    );
    const packDir = await mkdtemp(path.join(tmpdir(), "distill-e2e-pack-"));
    const installDir = await mkdtemp(path.join(tmpdir(), "distill-e2e-install-"));

    try {
      const pack = (args: string[], cwd: string) => {
        const result = Bun.spawnSync([packageManagerCommand, ...args], { cwd, stdout: "inherit", stderr: "inherit" });
        if (result.exitCode !== 0) throw new Error("Package command failed.");
      };
      pack(["pack", "--filter", currentPlatformPackage!, "--pack-destination", packDir], root);
      pack(["pack", "--filter", "@samuelfaj/distill", "--pack-destination", packDir], root);
      const tarballs = readdirSync(packDir).sort().map((entry) => path.join(packDir, entry));
      pack(["add", ...tarballs], installDir);
      await writeFile(path.join(installDir, "distill.config.ts"), `export default { provider: "external", host: "${fake.host}" };\n`);

      const installedShim = path.join(installDir, "node_modules", ".bin", process.platform === "win32" ? "distill.cmd" : "distill");
      const version = await runProcess(installedShim, ["--version"], { cwd: installDir });
      expect(version.code).toBe(0);
      expect(version.stdout.trim()).toBe(cliPackage.version);

      const summary = await runProcess(installedShim, ["did the tests pass?"], {
        cwd: installDir,
        inputSteps: [{ data: "12 passed\n" }],
      });
      expect(summary.code).toBe(0);
      expect(summary.stdout.trim()).toBe("Tests passed.");
    } finally {
      fake.stop();
      await rm(packDir, { recursive: true, force: true });
      await rm(installDir, { recursive: true, force: true });
    }
  }, process.platform === "win32" ? 300_000 : undefined);
});
