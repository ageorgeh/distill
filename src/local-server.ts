import { spawn, spawnSync } from "node:child_process";
import { closeSync, createWriteStream, openSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { LocalBackend, RuntimeConfig } from "./config";
import { resolveConfigBaseDir } from "./user-config";

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type ResolvedLocalBackend = "mlx" | "llamacpp";

export interface ProbeResult {
  status: "ready" | "down" | "incompatible";
}

interface StartupLockOwner {
  pid: number;
  startTimeTicks?: string;
}

interface EnsureLocalServerOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform | string;
  arch?: string;
  fetchImpl?: FetchImplementation;
  probeServer?: (config: RuntimeConfig) => Promise<ProbeResult>;
  installRuntime?: (
    backend: ResolvedLocalBackend,
    config: RuntimeConfig
  ) => Promise<string>;
  spawnServer?: (
    runtimePath: string,
    args: string[],
    config: RuntimeConfig
  ) => Promise<void>;
  sleepMs?: (ms: number) => Promise<void>;
  startupTimeoutMs?: number;
}

const MLX_MODEL = "samuelfaj/distill-1.7B-4bit-MLX";
const LLAMA_REPO = "samuelfaj/distill-1.7B-4bit-GGUF:Q4_K_M";
const LLAMA_FILE = "distill-1.7B-Q4_K_M.GGUF";
const LLAMA_ALIAS = "distill-local";
const STARTUP_TIMEOUT_MS = 90_000;
const PROBE_INTERVAL_MS = 500;
const EXTRA_EXECUTABLE_DIRS = [
  ".local/bin",
  ".nix-profile/bin",
  ".local/state/nix/profile/bin",
];

export function resolveLocalBackend(
  backend: LocalBackend,
  platform: string = process.platform,
  arch: string = process.arch
): ResolvedLocalBackend {
  if (backend !== "auto") {
    return backend;
  }

  return platform === "darwin" && arch === "arm64" ? "mlx" : "llamacpp";
}

export function buildLocalServerArgs(
  backend: ResolvedLocalBackend,
  config: RuntimeConfig
): string[] {
  if (backend === "mlx") {
    return [
      "--model",
      MLX_MODEL,
      "--host",
      config.localHost,
      "--port",
      String(config.localPort),
      "--decode-concurrency",
      String(config.localConcurrency),
      "--prompt-concurrency",
      String(config.localConcurrency)
    ];
  }

  return [
    "--hf-repo",
    LLAMA_REPO,
    "--hf-file",
    LLAMA_FILE,
    "--host",
    config.localHost,
    "--port",
    String(config.localPort),
    "--parallel",
    String(config.localConcurrency),
    "--cont-batching",
    "--alias",
    LLAMA_ALIAS
  ];
}

export async function ensureLocalServer(
  config: RuntimeConfig,
  options: EnsureLocalServerOptions = {}
): Promise<void> {
  if (config.provider !== "local") {
    return;
  }

  const env = options.env ?? process.env;
  const probeServer = options.probeServer ?? ((runtimeConfig) =>
    probeLocalServer(runtimeConfig, options.fetchImpl ?? fetch));
  const firstProbe = await probeServer(config);

  if (firstProbe.status === "ready") {
    return;
  }

  if (firstProbe.status === "incompatible") {
    throw new Error(
      `Local distill server port ${config.localHost}:${config.localPort} is already in use by a non-compatible service. See ${localServerLogPath(env)}.`
    );
  }

  const start = async () => {
    const secondProbe = await probeServer(config);

    if (secondProbe.status === "ready") {
      return;
    }

    if (secondProbe.status === "incompatible") {
      throw new Error(
        `Local distill server port ${config.localHost}:${config.localPort} is already in use by a non-compatible service. See ${localServerLogPath(env)}.`
      );
    }

    const backend = resolveLocalBackend(
      config.localBackend,
      options.platform ?? process.platform,
      options.arch ?? process.arch
    );
    const installRuntimeFn =
      options.installRuntime ??
      ((selectedBackend: ResolvedLocalBackend, runtimeConfig: RuntimeConfig) =>
        installRuntime(selectedBackend, runtimeConfig, env));
    const runtimePath = await installRuntimeFn(
      backend,
      config
    );
    const args = buildLocalServerArgs(backend, config);

    const spawnServerFn =
      options.spawnServer ??
      ((selectedRuntimePath: string, selectedArgs: string[], runtimeConfig: RuntimeConfig) =>
        spawnLocalServer(selectedRuntimePath, selectedArgs, runtimeConfig, env));
    await spawnServerFn(runtimePath, args, config);
    await waitForServer(config, probeServer, {
      env,
      sleepMs: options.sleepMs,
      timeoutMs: options.startupTimeoutMs
    });
  };

  if (options.probeServer || options.installRuntime || options.spawnServer) {
    await start();
    return;
  }

  await withStartupLock(env, start);
}

async function probeLocalServer(
  config: RuntimeConfig,
  fetchImpl: FetchImplementation
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);

  try {
    const url = buildLocalModelsUrl(config.host);
    const response = await fetchImpl(url, { signal: controller.signal });

    if (!response.ok) {
      return { status: "incompatible" };
    }

    const payload = (await response.json()) as { data?: unknown };

    return Array.isArray(payload.data)
      ? { status: "ready" }
      : { status: "incompatible" };
  } catch {
    return { status: "down" };
  } finally {
    clearTimeout(timeout);
  }
}

function buildLocalModelsUrl(baseUrl: string): URL {
  const normalized = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const pathname = normalized.pathname.replace(/\/+$/, "");

  normalized.pathname =
    pathname === "" || pathname === "/"
      ? "/v1/models"
      : `${pathname}/models`;
  normalized.search = "";
  normalized.hash = "";

  return normalized;
}

async function waitForServer(
  config: RuntimeConfig,
  probeServer: (config: RuntimeConfig) => Promise<ProbeResult>,
  options: {
    env?: NodeJS.ProcessEnv;
    sleepMs?: (ms: number) => Promise<void>;
    timeoutMs?: number;
  } = {}
): Promise<void> {
  const sleepMs =
    options.sleepMs ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + (options.timeoutMs ?? STARTUP_TIMEOUT_MS);

  while (Date.now() < deadline) {
    await sleepMs(PROBE_INTERVAL_MS);
    const probe = await probeServer(config);

    if (probe.status === "ready") {
      return;
    }

    if (probe.status === "incompatible") {
      throw new Error(
        `Local distill server port ${config.localHost}:${config.localPort} became incompatible during startup. See ${localServerLogPath(options.env ?? process.env)}.`
      );
    }
  }

  throw new Error(
    `Local distill server did not become ready at ${config.localHost}:${config.localPort}. See ${localServerLogPath(options.env ?? process.env)}.`
  );
}

async function withStartupLock(
  env: NodeJS.ProcessEnv,
  callback: () => Promise<void>
): Promise<void> {
  const lockPath = path.join(resolveConfigBaseDir(), "local-server.lock");
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 30_000;
  const owner = await currentStartupLockOwner();

  while (true) {
    try {
      await writeFile(lockPath, serializeStartupLockOwner(owner), { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      if (await reclaimStaleStartupLock(lockPath)) {
        continue;
      }

      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for local distill server lock: ${lockPath}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  try {
    await callback();
  } finally {
    await rm(lockPath, { force: true });
  }
}

export async function reclaimStaleStartupLock(lockPath: string): Promise<boolean> {
  const owner = await readLockOwner(lockPath);

  if (owner === null) {
    await rm(lockPath, { force: true });
    return true;
  }

  if (!(await isStartupLockOwnerAlive(owner))) {
    await rm(lockPath, { force: true });
    return true;
  }

  return false;
}

function serializeStartupLockOwner(owner: StartupLockOwner): string {
  return JSON.stringify(owner);
}

async function currentStartupLockOwner(): Promise<StartupLockOwner> {
  const startTimeTicks = await readLinuxProcessStartTime(process.pid);

  return startTimeTicks ? { pid: process.pid, startTimeTicks } : { pid: process.pid };
}

async function readLockOwner(lockPath: string): Promise<StartupLockOwner | null> {
  try {
    const raw = (await readFile(lockPath, "utf8")).trim();

    if (!raw) {
      return null;
    }

    return parseStartupLockOwner(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function parseStartupLockOwner(raw: string): StartupLockOwner | null {
  const legacyPid = Number(raw);

  if (Number.isInteger(legacyPid) && legacyPid > 0) {
    return { pid: legacyPid };
  }

  try {
    const parsed = JSON.parse(raw) as {
      pid?: unknown;
      startTimeTicks?: unknown;
    };

    if (!Number.isInteger(parsed.pid) || (parsed.pid as number) <= 0) {
      return null;
    }

    return {
      pid: parsed.pid as number,
      startTimeTicks:
        typeof parsed.startTimeTicks === "string" && parsed.startTimeTicks
          ? parsed.startTimeTicks
          : undefined
    };
  } catch {
    return null;
  }
}

async function isStartupLockOwnerAlive(owner: StartupLockOwner): Promise<boolean> {
  if (!isProcessAlive(owner.pid)) {
    return false;
  }

  if (!owner.startTimeTicks || process.platform !== "linux") {
    return true;
  }

  const currentStartTimeTicks = await readLinuxProcessStartTime(owner.pid);

  return currentStartTimeTicks === owner.startTimeTicks;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "ESRCH") {
      return false;
    }

    return true;
  }
}

async function readLinuxProcessStartTime(pid: number): Promise<string | null> {
  if (process.platform !== "linux") {
    return null;
  }

  try {
    const statLine = await readFile(`/proc/${pid}/stat`, "utf8");

    return parseLinuxProcessStartTime(statLine);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "ENOENT" || code === "ESRCH") {
      return null;
    }

    throw error;
  }
}

function parseLinuxProcessStartTime(statLine: string): string | null {
  const commandEnd = statLine.lastIndexOf(")");

  if (commandEnd === -1) {
    return null;
  }

  const fields = statLine
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/);

  return fields[19] ?? null;
}

async function installRuntime(
  backend: ResolvedLocalBackend,
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv
): Promise<string> {
  return backend === "mlx"
    ? installMlxRuntime(env)
    : installLlamaRuntime(env, config);
}

async function installMlxRuntime(env: NodeJS.ProcessEnv): Promise<string> {
  const override = await resolveRuntimeOverridePath("mlx", env);

  if (override) {
    return override;
  }

  const existing = await findExecutable("mlx_lm.server", env);

  if (existing) {
    return existing;
  }

  const uv = await findExecutable("uv", env);

  if (uv) {
    const result = spawnSync(uv, ["tool", "install", "mlx-lm"], {
      env,
      stdio: "inherit"
    });

    if (result.status === 0) {
      const installed = await findExecutable("mlx_lm.server", env);

      if (installed) {
        return installed;
      }
    }
  }

  const python = (await findExecutable("python3", env)) ?? (await findExecutable("python", env));

  if (python) {
    const result = spawnSync(python, ["-m", "pip", "install", "--user", "mlx-lm"], {
      env,
      stdio: "inherit"
    });

    if (result.status === 0) {
      const installed =
        (await findExecutable("mlx_lm.server", env)) ??
        (await findPythonUserBaseExecutable(python, "mlx_lm.server", env));

      if (installed) {
        return installed;
      }
    }
  }

  throw new Error(
    "Could not install mlx-lm automatically. Run: uv tool install mlx-lm"
  );
}

async function installLlamaRuntime(
  env: NodeJS.ProcessEnv,
  config: RuntimeConfig
): Promise<string> {
  const override = await resolveRuntimeOverridePath("llamacpp", env);

  if (override) {
    return override;
  }

  const existing = await findExecutable("llama-server", env);

  if (existing) {
    return existing;
  }

  if (await isNixOs(env)) {
    throw new Error(
      "NixOS detected and llama-server is not installed. Install the `llama-cpp` package so `llama-server` is on PATH, or set DISTILL_LLAMA_SERVER_PATH."
    );
  }

  let runtimePath: string | null = null;

  try {
    runtimePath = await downloadOfficialLlamaServer(
      env,
      process.platform,
      process.arch
    );
  } catch {
    runtimePath = null;
  }

  if (runtimePath) {
    return runtimePath;
  }

  throw new Error(
    `Could not install llama.cpp automatically. Run: ${manualLlamaInstallCommand(env, process.platform)}`
  );
}

export function manualLlamaInstallCommand(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): string {
  if (platform === "win32") {
    return "winget install llama.cpp";
  }

  if (env.NIX_PROFILES || env.IN_NIX_SHELL || env.NIX_PATH) {
    return "install the `llama-cpp` package and ensure `llama-server` is on PATH";
  }

  return "brew install llama.cpp";
}

async function downloadOfficialLlamaServer(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  arch: string
): Promise<string | null> {
  const assetSuffix = selectLlamaAssetSuffix(platform, arch);

  if (!assetSuffix) {
    return null;
  }

  const release = await fetchJson<{
    tag_name: string;
    assets: Array<{ name: string; browser_download_url: string }>;
  }>("https://api.github.com/repos/ggml-org/llama.cpp/releases/latest");
  const asset = release.assets.find((item) =>
    item.name === `llama-${release.tag_name}-bin-${assetSuffix}`
  );

  if (!asset) {
    return null;
  }

  const runtimeDir = path.join(
    resolveConfigBaseDir(),
    "runtimes",
    "llama.cpp",
    release.tag_name
  );
  const binaryName = platform === "win32" ? "llama-server.exe" : "llama-server";
  const existing = await findFileRecursive(runtimeDir, binaryName);

  if (existing) {
    return existing;
  }

  await mkdir(runtimeDir, { recursive: true });
  const archivePath = path.join(runtimeDir, asset.name);
  await downloadFile(asset.browser_download_url, archivePath);

  const extracted = await extractArchive(archivePath, runtimeDir, platform);

  if (!extracted) {
    return null;
  }

  return findFileRecursive(runtimeDir, binaryName);
}

function selectLlamaAssetSuffix(
  platform: NodeJS.Platform,
  arch: string
): string | null {
  if (platform === "darwin" && arch === "arm64") {
    return "macos-arm64.tar.gz";
  }

  if (platform === "darwin" && arch === "x64") {
    return "macos-x64.tar.gz";
  }

  if (platform === "linux" && arch === "x64") {
    return "ubuntu-x64.tar.gz";
  }

  if (platform === "linux" && arch === "arm64") {
    return "ubuntu-arm64.tar.gz";
  }

  if (platform === "win32" && arch === "x64") {
    return "win-cpu-x64.zip";
  }

  if (platform === "win32" && arch === "arm64") {
    return "win-cpu-arm64.zip";
  }

  return null;
}

async function extractArchive(
  archivePath: string,
  outputDir: string,
  platform: NodeJS.Platform
): Promise<boolean> {
  const result = archivePath.endsWith(".tar.gz")
    ? spawnSync("tar", ["-xzf", archivePath, "-C", outputDir], {
        stdio: "inherit"
      })
    : platform === "win32"
      ? spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            "Expand-Archive",
            "-Force",
            "-LiteralPath",
            archivePath,
            "-DestinationPath",
            outputDir
          ],
          { stdio: "inherit" }
        )
      : spawnSync("unzip", ["-q", archivePath, "-d", outputDir], {
          stdio: "inherit"
        });

  return result.status === 0;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "distill"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}.`);
  }

  return (await response.json()) as T;
}

async function downloadFile(url: string, outputPath: string): Promise<void> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "distill"
    }
  });

  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status}.`);
  }

  await pipeline(
    Readable.fromWeb(response.body as unknown as ReadableStream),
    createWriteStream(outputPath)
  );
}

async function spawnLocalServer(
  runtimePath: string,
  args: string[],
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const logPath = localServerLogPath(env);
  await mkdir(path.dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, "a");
  let child;

  try {
    child = spawn(runtimePath, args, {
      detached: true,
      env,
      stdio: ["ignore", logFd, logFd]
    });
  } finally {
    closeSync(logFd);
  }

  child.unref();
  await writeFile(
    path.join(path.dirname(logPath), "local-server.pid"),
    `${child.pid ?? ""}\n`
  );

  if (!child.pid) {
    throw new Error(
      `Failed to start local distill server at ${config.localHost}:${config.localPort}. See ${logPath}.`
    );
  }
}

function localServerLogPath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveConfigBaseDir(), "logs", "local-server.log");
}

async function resolveRuntimeOverridePath(
  backend: ResolvedLocalBackend,
  env: NodeJS.ProcessEnv
): Promise<string | null> {
  const rawPath = (
    backend === "mlx"
      ? env.DISTILL_MLX_SERVER_PATH
      : env.DISTILL_LLAMA_SERVER_PATH
  )?.trim() || env.DISTILL_LOCAL_RUNTIME_PATH?.trim();

  if (!rawPath) {
    return null;
  }

  return (await fileExists(rawPath)) ? rawPath : null;
}

async function isNixOs(env: NodeJS.ProcessEnv): Promise<boolean> {
  return Boolean(
    env.NIX_PROFILES ||
      env.IN_NIX_SHELL ||
      env.NIX_PATH ||
      (await fileExists("/etc/NIXOS")) ||
      (await fileExists("/run/current-system/nixos-version"))
  );
}

async function findExecutable(
  command: string,
  env: NodeJS.ProcessEnv
): Promise<string | null> {
  const directories = executableSearchDirectories(env);
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];

  for (const directory of directories) {
    if (!directory) {
      continue;
    }

    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);

      if (await fileExists(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function executableSearchDirectories(env: NodeJS.ProcessEnv): string[] {
  const directories = new Set<string>();
  const pathValue = env.PATH ?? "";

  for (const directory of pathValue.split(path.delimiter)) {
    if (directory) {
      directories.add(directory);
    }
  }

  const home = env.HOME?.trim() || env.USERPROFILE?.trim();

  if (home) {
    for (const relativeDir of EXTRA_EXECUTABLE_DIRS) {
      directories.add(path.join(home, relativeDir));
    }
  }

  if (env.USER?.trim()) {
    directories.add(path.join("/etc/profiles/per-user", env.USER, "bin"));
  }

  directories.add("/run/current-system/sw/bin");
  directories.add("/nix/var/nix/profiles/default/bin");

  return [...directories];
}

async function findPythonUserBaseExecutable(
  python: string,
  command: string,
  env: NodeJS.ProcessEnv
): Promise<string | null> {
  const result = spawnSync(python, ["-m", "site", "--user-base"], {
    env,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    return null;
  }

  const base = result.stdout.trim();

  if (!base) {
    return null;
  }

  const candidate = path.join(
    base,
    process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? `${command}.exe` : command
  );

  return (await fileExists(candidate)) ? candidate : null;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const result = await stat(filePath);
    return result.isFile();
  } catch {
    return false;
  }
}

async function findFileRecursive(
  root: string,
  fileName: string
): Promise<string | null> {
  try {
    const entries = await readdir(root, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(root, entry.name);

      if (entry.isFile() && entry.name === fileName) {
        return entryPath;
      }

      if (entry.isDirectory()) {
        const nested = await findFileRecursive(entryPath, fileName);

        if (nested) {
          return nested;
        }
      }
    }
  } catch {
    return null;
  }

  return null;
}
