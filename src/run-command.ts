import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { ResolvedConfig, RunRequest } from "./config";
import { resolveToolOutputTokenLimit, resultBudget, type ResolvedToolOutputLimit } from "./codex-config";
import { createOutputProvider, type OutputProvider } from "./llm";
import { resolveTelemetryDirectory, telemetryId, writeTelemetry } from "./telemetry";

export const DEFAULT_RUN_QUESTION = "If the command failed, report actionable root causes, relevant paths, line numbers, test names, and error messages. For requested checks, report compact pass, fail, or skipped totals. Omit successful detail.";
export const RUN_SUMMARY_TARGET_BYTES = 2_000;
export const RUN_SUMMARY_MAX_BYTES = 8_000;
const RUN_ENVELOPE_RESERVE_BYTES = 96;
interface CapturedCommand { stdout: string; stderr: string; exitCode: number | null; terminationError?: string; }
type ResolveLimit = () => Promise<ResolvedToolOutputLimit | number>;

export function resolveCommandShell(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { executable: string; args: string[] } {
  if (platform === "win32") {
    return { executable: environment.ComSpec?.trim() || "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  return { executable: environment.SHELL?.trim() || "/bin/sh", args: ["-l", "-c", command] };
}

export function resolveCommandEnvironment(
  inherited: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const environment = { ...inherited };
  if (platform !== "win32") delete environment.__NIXOS_SET_ENVIRONMENT_DONE;
  return environment;
}

function execute(command: string, cwd: string, timeoutMs: number): Promise<CapturedCommand> {
  return new Promise((resolve) => {
    let stdout = ""; let stderr = ""; let done = false;
    const environment = resolveCommandEnvironment();
    const shell = resolveCommandShell(command, environment);
    const child = spawn(shell.executable, shell.args, {
      cwd,
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    }) as unknown as ChildProcessWithoutNullStreams;
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

function resultHeader(status: "PASS" | "FAIL", captured: CapturedCommand, exceptional?: "provider-error" | "execution-error"): string {
  const flags = [
    ...(captured.terminationError?.startsWith("Command timed out") ? ["timeout"] : []),
    ...(exceptional ? [exceptional] : []),
  ];
  return `${status} exit=${captured.exitCode ?? "null"}${flags.length ? ` ${flags.join(" ")}` : ""}`;
}

function renderResult(header: string, payload: string, maxBytes: number): { text: string; capped: boolean } {
  const value = payload ? `${header}\n${payload}` : header;
  if (Buffer.byteLength(value) <= maxBytes) return { text: value, capped: false };
  const truncatedHeader = `${header} truncated`;
  const payloadBudget = Math.max(128, maxBytes - Buffer.byteLength(truncatedHeader) - 1);
  const bounded = boundResult(payload, payloadBudget);
  return { text: `${truncatedHeader}\n${bounded.text}`, capped: true };
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
      const responseByteBudget = Math.min(budget.resultByteBudget, RUN_SUMMARY_MAX_BYTES + RUN_ENVELOPE_RESERVE_BYTES);
      const summaryMaxBytes = Math.max(128, responseByteBudget - RUN_ENVELOPE_RESERVE_BYTES);
      const summaryTargetBytes = Math.min(RUN_SUMMARY_TARGET_BYTES, summaryMaxBytes);
      const commandStartedAt = Date.now(); captured = await execute(request.command, workspaceRoot, config.output.timeoutMs); const commandDurationMs = Date.now() - commandStartedAt;
      const combined = `${captured.stdout}${captured.stderr}${captured.terminationError ? `\n${captured.terminationError}` : ""}`;
      const status = captured.exitCode === 0 ? "PASS" : "FAIL";
      let header = resultHeader(status, captured); let payload = ""; let distilled = false; let fallbackReason: string | undefined; let providerDurationMs: number | undefined; let providerUsage: unknown;
      if (!combined) payload = "";
      else if (Buffer.byteLength(combined) <= config.output.smallOutputBytes) payload = combined;
      else {
        try {
          const summary = await (dependencies.provider ?? createOutputProvider(config.output)).summarize({ command: request.command, question: request.question ?? DEFAULT_RUN_QUESTION, exitCode: captured.exitCode, stdout: captured.stdout, stderr: captured.stderr, targetOutputBytes: summaryTargetBytes, maxOutputBytes: summaryMaxBytes });
          payload = summary.text; distilled = true; providerDurationMs = summary.durationMs; providerUsage = summary.usage;
        } catch { header = resultHeader(status, captured, "provider-error"); payload = combined; fallbackReason = "provider-error"; }
      }
      const bounded = renderResult(header, payload, responseByteBudget);
      await writeTelemetry(resolveTelemetryDirectory(config.telemetry.directory, dependencies.telemetryDirectory), id, {
        ...base, durationMs: Date.now() - startedAt, commandDurationMs, ...(providerDurationMs !== undefined ? { providerDurationMs } : {}), ...(providerUsage ? { providerUsage } : {}),
        resolvedToolOutputTokenLimit: resolved.limit, toolOutputLimitSource: resolved.source, ...(resolved.configPath ? { toolOutputConfigPath: resolved.configPath } : {}), ...budget,
        exitCode: captured.exitCode, stdoutBytes: Buffer.byteLength(captured.stdout), stderrBytes: Buffer.byteLength(captured.stderr), rawBytes: Buffer.byteLength(combined), resultBytes: Buffer.byteLength(bounded.text), compressionRatio: combined ? Number((Buffer.byteLength(bounded.text) / Buffer.byteLength(combined)).toFixed(4)) : 1,
        resultCapped: bounded.capped, distilled, ...(fallbackReason ? { fallbackReason } : {}), result: bounded.text,
      });
      return bounded.text;
    } catch (error) {
      const result = `${resultHeader("FAIL", captured, "execution-error")}\n${error instanceof Error ? error.message : String(error)}`;
      await writeTelemetry(resolveTelemetryDirectory(config.telemetry.directory, dependencies.telemetryDirectory), id, { ...base, durationMs: Date.now() - startedAt, exitCode: captured.exitCode, stdoutBytes: Buffer.byteLength(captured.stdout), stderrBytes: Buffer.byteLength(captured.stderr), resultBytes: Buffer.byteLength(result), distilled: false, fallbackReason: "execution-error", result });
      return result;
    }
  };
}
