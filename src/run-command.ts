import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { ResolvedConfig, RunRequest } from "./config";
import { resolveToolOutputTokenLimit, resultBudget, type ResolvedToolOutputLimit } from "./codex-config";
import { createOutputProvider, type OutputProvider } from "./llm";
import { resolveTelemetryDirectory, telemetryId, writeTelemetry } from "./telemetry";

export const DEFAULT_RUN_QUESTION = "Report whether the command succeeded. If it failed, include actionable root causes, relevant paths, line numbers, test names, and error messages. Omit successful noise.";
interface CapturedCommand { stdout: string; stderr: string; exitCode: number | null; terminationError?: string; }
type ResolveLimit = () => Promise<ResolvedToolOutputLimit | number>;

function execute(command: string, cwd: string, timeoutMs: number): Promise<CapturedCommand> {
  return new Promise((resolve) => {
    let stdout = ""; let stderr = ""; let done = false;
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] }) as unknown as ChildProcessWithoutNullStreams;
    const finish = (result: CapturedCommand) => { if (!done) { done = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { child.kill(); finish({ stdout, stderr, exitCode: null, terminationError: `Command timed out after ${timeoutMs}ms.` }); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); }); child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => finish({ stdout, stderr, exitCode: null, terminationError: error.message }));
    child.on("close", (code, signal) => finish({ stdout, stderr, exitCode: code, ...(signal ? { terminationError: `Command terminated by ${signal}.` } : {}) }));
  });
}

/** Keep whole lines and never cut a diagnostic, path, or command mid-item. */
export function boundResult(value: string, maxBytes: number): { text: string; capped: boolean } {
  if (Buffer.byteLength(value) <= maxBytes) return { text: value, capped: false };
  const marker = "[additional diagnostics omitted to fit parent tool-output budget]";
  const lines = value.split(/(?<=\n)/); const selected: string[] = []; let used = 0;
  for (const line of lines) {
    if (Buffer.byteLength(line) + used + Buffer.byteLength(marker) + 1 > maxBytes) break;
    selected.push(line); used += Buffer.byteLength(line);
  }
  return { text: `${selected.join("").trimEnd()}${selected.length ? "\n" : ""}${marker}`, capped: true };
}

function normalizeLimit(value: ResolvedToolOutputLimit | number): ResolvedToolOutputLimit {
  return typeof value === "number" ? { limit: value, source: "default" } : value;
}

export function createRunHandler(config: ResolvedConfig, dependencies: { provider?: OutputProvider; resolveLimit?: ResolveLimit; telemetryDirectory?: string } = {}) {
  return async (request: RunRequest): Promise<string> => {
    const id = telemetryId(); const startedAt = Date.now(); let captured: CapturedCommand = { stdout: "", stderr: "", exitCode: null };
    const base = { id, timestamp: new Date().toISOString(), mode: "run" as const, workspaceRoot: request.workspaceRoot, command: request.command, ...(request.question ? { question: request.question } : {}), provider: config.output.provider, model: config.output.model };
    try {
      if (!path.isAbsolute(request.workspaceRoot)) throw new Error("workspaceRoot must be an absolute path.");
      const workspaceRoot = await realpath(request.workspaceRoot);
      const resolved = normalizeLimit(await (dependencies.resolveLimit ?? resolveToolOutputTokenLimit)());
      const budget = resultBudget(resolved);
      const commandStartedAt = Date.now(); captured = await execute(request.command, workspaceRoot, config.output.timeoutMs); const commandDurationMs = Date.now() - commandStartedAt;
      const combined = `${captured.stdout}${captured.stderr}${captured.terminationError ? `\n${captured.terminationError}` : ""}`;
      const status = captured.exitCode === 0 ? "PASS" : "FAIL";
      let result: string; let distilled = false; let fallbackReason: string | undefined; let providerDurationMs: number | undefined; let providerUsage: unknown;
      if (!combined) result = `COMMAND ${status} exit=${captured.exitCode ?? "null"} output=empty`;
      else if (Buffer.byteLength(combined) <= config.output.smallOutputBytes) result = `COMMAND ${status} exit=${captured.exitCode ?? "null"} distilled=no reason=small-output\n${combined}`;
      else {
        try {
          const summary = await (dependencies.provider ?? createOutputProvider(config.output)).summarize({ command: request.command, question: request.question ?? DEFAULT_RUN_QUESTION, exitCode: captured.exitCode, stdout: captured.stdout, stderr: captured.stderr, maxOutputBytes: Math.max(128, budget.resultByteBudget - 80) });
          result = `COMMAND ${status} exit=${captured.exitCode ?? "null"} distilled=yes\n${summary.text}`; distilled = true; providerDurationMs = summary.durationMs; providerUsage = summary.usage;
        } catch { result = `COMMAND ${status} exit=${captured.exitCode ?? "null"} distilled=no reason=provider-error\n${combined}`; fallbackReason = "provider-error"; }
      }
      const bounded = boundResult(result, budget.resultByteBudget);
      await writeTelemetry(resolveTelemetryDirectory(config.telemetry.directory, dependencies.telemetryDirectory), id, {
        ...base, durationMs: Date.now() - startedAt, commandDurationMs, ...(providerDurationMs !== undefined ? { providerDurationMs } : {}), ...(providerUsage ? { providerUsage } : {}),
        resolvedToolOutputTokenLimit: resolved.limit, toolOutputLimitSource: resolved.source, ...(resolved.configPath ? { toolOutputConfigPath: resolved.configPath } : {}), ...budget,
        exitCode: captured.exitCode, stdoutBytes: Buffer.byteLength(captured.stdout), stderrBytes: Buffer.byteLength(captured.stderr), rawBytes: Buffer.byteLength(combined), resultBytes: Buffer.byteLength(bounded.text), compressionRatio: combined ? Number((Buffer.byteLength(bounded.text) / Buffer.byteLength(combined)).toFixed(4)) : 1,
        resultCapped: bounded.capped, distilled, ...(fallbackReason ? { fallbackReason } : {}), result: bounded.text,
      });
      return bounded.text;
    } catch (error) {
      const result = `COMMAND FAIL exit=${captured.exitCode ?? "null"} distilled=no reason=execution-error\n${error instanceof Error ? error.message : String(error)}`;
      await writeTelemetry(resolveTelemetryDirectory(config.telemetry.directory, dependencies.telemetryDirectory), id, { ...base, durationMs: Date.now() - startedAt, exitCode: captured.exitCode, stdoutBytes: Buffer.byteLength(captured.stdout), stderrBytes: Buffer.byteLength(captured.stderr), resultBytes: Buffer.byteLength(result), distilled: false, fallbackReason: "execution-error", result });
      return result;
    }
  };
}
