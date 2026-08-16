import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { ResolvedConfig, RunRequest } from "./config";
import { resolveToolOutputTokenLimit, resultBudget } from "./codex-config";
import { createOutputProvider, type OutputProvider } from "./llm";
import { resolveTelemetryDirectory, telemetryId, writeTelemetry } from "./telemetry";

export const DEFAULT_RUN_QUESTION = "Report whether the command succeeded. If it failed, include the actionable failures, relevant paths, line numbers, test names, and error messages. Omit successful noise.";

interface CapturedCommand { stdout: string; stderr: string; exitCode: number | null; terminationError?: string; }

function execute(command: string, cwd: string, timeoutMs: number): Promise<CapturedCommand> {
  return new Promise((resolve) => {
    let stdout = ""; let stderr = ""; let done = false;
  const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] }) as unknown as ChildProcessWithoutNullStreams;
    const finish = (result: CapturedCommand) => { if (!done) { done = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { child.kill(); finish({ stdout, stderr, exitCode: null, terminationError: `Command timed out after ${timeoutMs}ms.` }); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => finish({ stdout, stderr, exitCode: null, terminationError: error.message }));
    child.on("close", (code, signal) => finish({ stdout, stderr, exitCode: code, ...(signal ? { terminationError: `Command terminated by ${signal}.` } : {}) }));
  });
}

function sample(raw: string, maxBytes: number): string {
  if (Buffer.byteLength(raw) <= maxBytes) return raw;
  const half = Math.max(64, Math.floor((maxBytes - 48) / 2));
  const head = Buffer.from(raw).subarray(0, half).toString("utf8");
  const tail = Buffer.from(raw).subarray(Math.max(0, Buffer.byteLength(raw) - half)).toString("utf8");
  return `[output head]\n${head}\n...\n[output tail]\n${tail}`;
}

export function createRunHandler(config: ResolvedConfig, dependencies: { provider?: OutputProvider; resolveLimit?: () => Promise<number>; telemetryDirectory?: string } = {}) {
  return async (request: RunRequest): Promise<string> => {
    const id = telemetryId(); const startedAt = Date.now(); let captured: CapturedCommand = { stdout: "", stderr: "", exitCode: null };
    const base = { id, timestamp: new Date().toISOString(), mode: "run" as const, workspaceRoot: request.workspaceRoot, command: request.command, ...(request.question ? { question: request.question } : {}), provider: config.output.provider, model: config.output.model };
    try {
      if (!path.isAbsolute(request.workspaceRoot)) throw new Error("workspaceRoot must be an absolute path.");
      const workspaceRoot = await realpath(request.workspaceRoot);
      captured = await execute(request.command, workspaceRoot, config.output.timeoutMs);
      const combined = `${captured.stdout}${captured.stderr}`;
      const passed = captured.exitCode === 0;
      const status = passed ? "PASS" : "FAIL";
      let result: string; let distilled = false; let fallbackReason: string | undefined;
      if (!combined) result = `COMMAND ${status} exit=${captured.exitCode ?? "null"} output=empty`;
      else if (Buffer.byteLength(combined) <= config.output.smallOutputBytes) result = `COMMAND ${status} exit=${captured.exitCode ?? "null"} distilled=no reason=small-output\n${combined}`;
      else {
        try {
          const answer = await (dependencies.provider ?? createOutputProvider(config.output)).summarize({ command: request.command, question: request.question ?? DEFAULT_RUN_QUESTION, exitCode: captured.exitCode, stdout: captured.stdout, stderr: captured.stderr });
          result = `COMMAND ${status} exit=${captured.exitCode ?? "null"} distilled=yes\n${answer}`; distilled = true;
        } catch {
          const limit = await (dependencies.resolveLimit ?? resolveToolOutputTokenLimit)();
          const { resultByteBudget } = resultBudget(limit);
          result = `COMMAND ${status} exit=${captured.exitCode ?? "null"} distilled=no reason=provider-error\n${sample(combined, Math.max(128, resultByteBudget - 90))}`;
          fallbackReason = "provider-error";
        }
      }
      await writeTelemetry(resolveTelemetryDirectory(config.telemetry.directory, dependencies.telemetryDirectory), id, { ...base, durationMs: Date.now() - startedAt, exitCode: captured.exitCode, stdoutBytes: Buffer.byteLength(captured.stdout), stderrBytes: Buffer.byteLength(captured.stderr), resultBytes: Buffer.byteLength(result), distilled, ...(fallbackReason ? { fallbackReason } : {}) });
      return result;
    } catch (error) {
      const result = `COMMAND FAIL exit=${captured.exitCode ?? "null"} distilled=no reason=execution-error\n${error instanceof Error ? error.message : String(error)}`;
      await writeTelemetry(resolveTelemetryDirectory(config.telemetry.directory, dependencies.telemetryDirectory), id, { ...base, durationMs: Date.now() - startedAt, exitCode: captured.exitCode, stdoutBytes: Buffer.byteLength(captured.stdout), stderrBytes: Buffer.byteLength(captured.stderr), resultBytes: Buffer.byteLength(result), distilled: false, fallbackReason: "execution-error" });
      return result;
    }
  };
}
