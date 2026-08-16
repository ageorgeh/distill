#!/usr/bin/env node

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const requireFromHere = createRequire(__filename);
const packages = {
  "darwin-arm64": ["@samuelfaj/distill-darwin-arm64", "distill"], "darwin-x64": ["@samuelfaj/distill-darwin-x64", "distill"],
  "linux-arm64": ["@samuelfaj/distill-linux-arm64", "distill"], "linux-x64": ["@samuelfaj/distill-linux-x64", "distill"], "win32-x64": ["@samuelfaj/distill-win32-x64", "distill.exe"],
};
const target = packages[`${process.platform}-${process.arch}`];
if (!target) { console.error(`[distill] Unsupported platform: ${process.platform}/${process.arch}.`); process.exit(1); }
const [packageName, binaryName] = target;
const workspaceBinary = path.resolve(__dirname, "..", "..", `distill-${process.platform}-${process.arch}`, "bin", binaryName);
let binary = workspaceBinary;
const telemetryRoot = fs.existsSync(workspaceBinary)
  ? path.resolve(__dirname, "..", "..", "..")
  : path.resolve(__dirname, "..");
if (!fs.existsSync(binary)) {
  try { binary = path.join(path.dirname(requireFromHere.resolve(`${packageName}/package.json`)), "bin", binaryName); }
  catch { console.error(`[distill] Missing platform package ${packageName}. Reinstall @samuelfaj/distill for this platform.`); process.exit(1); }
}
const child = spawn(binary, process.argv.slice(2), {
  stdio: "inherit",
  env: { ...process.env, DISTILL_TELEMETRY_ROOT: telemetryRoot }
});
child.on("error", (error) => { console.error(`[distill] Failed to launch native binary: ${error.message}`); process.exit(1); });
child.on("exit", (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1); });
