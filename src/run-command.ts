import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { ResolvedConfig, RunRequest, RunStage } from "./config";
import { resolveToolOutputTokenLimit, resultBudget, type ResolvedToolOutputLimit } from "./codex-config";
import { createOutputProvider, type OutputProvider } from "./llm";
import { resolveTelemetryDirectory, telemetryId, writeTelemetry } from "./telemetry";

export const DEFAULT_RUN_QUESTION = "Report only actionable failures: the shared root cause, affected count, exact paths, line numbers, test names, and error messages. Omit successful stages and successful detail.";
export const RUN_SUMMARY_TARGET_BYTES = 2_000;
export const RUN_SUMMARY_MAX_BYTES = 8_000;
const RUN_ENVELOPE_RESERVE_BYTES = 96;
interface CapturedCommand { stdout: string; stderr: string; exitCode: number | null; terminationError?: string; }
interface ExecutedStage extends CapturedCommand, RunStage { durationMs: number; }
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

function requestStages(request: RunRequest): { stages: RunStage[]; batch: boolean } {
  return request.commands
    ? { stages: request.commands.map((stage) => ({ name: stage.name.trim().replace(/\s+/g, " "), command: stage.command })), batch: true }
    : { stages: [{ name: "command", command: request.command! }], batch: false };
}

function requestWorkspaceRoot(request: RunRequest): string {
  return request.workspaceRoot ?? request.cwd;
}

function stageOutput(stage: ExecutedStage): string {
  return `${stage.stdout}${stage.stderr}${stage.terminationError ? `${stage.stdout || stage.stderr ? "\n" : ""}${stage.terminationError}` : ""}`;
}

function stageStatus(stage: ExecutedStage): string {
  if (stage.exitCode === 0) return `${stage.name} pass`;
  const flag = stage.terminationError?.startsWith("Command timed out") ? " timeout" : stage.terminationError ? " execution-error" : "";
  return `${stage.name} fail exit=${stage.exitCode ?? "null"}${flag}`;
}

function batchHeader(stages: ExecutedStage[], exceptional?: "provider-error" | "execution-error"): string {
  const failed = stages.filter((stage) => stage.exitCode !== 0).length;
  return `${failed ? `FAIL stages=${stages.length} failed=${failed}` : `PASS stages=${stages.length}`}${exceptional ? ` ${exceptional}` : ""}`;
}

function rawStageOutput(stages: ExecutedStage[], batch: boolean, includeSuccessful = true): string {
  if (!batch) return stageOutput(stages[0]!);
  return stages.filter((stage) => includeSuccessful || stage.exitCode !== 0).flatMap((stage) => {
    const output = stageOutput(stage);
    return output ? [`output ${stage.name}\n${output}`] : [];
  }).join("\n");
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
    const id = telemetryId(); const startedAt = Date.now(); const requested = requestStages(request); let executed: ExecutedStage[] = [];
    const requestedWorkspaceRoot = requestWorkspaceRoot(request);
    const base = {
      id, timestamp: new Date().toISOString(), mode: "run" as const, workspaceRoot: requestedWorkspaceRoot,
      ...(requested.batch ? { commands: requested.stages } : { command: requested.stages[0]!.command }),
      ...(request.question ? { question: request.question } : {}), provider: config.output.provider, model: config.output.model,
    };
    try {
      if (!path.isAbsolute(requestedWorkspaceRoot)) throw new Error("workspaceRoot/cwd must be an absolute path.");
      const workspaceRoot = await realpath(requestedWorkspaceRoot);
      const resolved = normalizeLimit(await (dependencies.resolveLimit ?? resolveToolOutputTokenLimit)());
      const budget = resultBudget(resolved);
      const responseByteBudget = Math.min(budget.resultByteBudget, RUN_SUMMARY_MAX_BYTES + RUN_ENVELOPE_RESERVE_BYTES);
      const summaryMaxBytes = Math.max(128, responseByteBudget - RUN_ENVELOPE_RESERVE_BYTES);
      const summaryTargetBytes = Math.min(RUN_SUMMARY_TARGET_BYTES, summaryMaxBytes);
      for (const stage of requested.stages) {
        const stageStartedAt = Date.now();
        const captured = await execute(stage.command, workspaceRoot, config.output.timeoutMs);
        executed.push({ ...stage, ...captured, durationMs: Date.now() - stageStartedAt });
      }
      const rawOutputBytes = executed.reduce((total, stage) => total + Buffer.byteLength(stageOutput(stage)), 0);
      const failedStages = executed.filter((stage) => stage.exitCode !== 0);
      const aggregateExitCode = failedStages.length ? 1 : 0;
      const telemetryExitCode = requested.batch ? aggregateExitCode : executed[0]!.exitCode;
      let header = requested.batch ? batchHeader(executed) : resultHeader(aggregateExitCode === 0 ? "PASS" : "FAIL", executed[0]!);
      const statuses = requested.batch ? executed.map(stageStatus).join("\n") : "";
      let diagnostics = ""; let distilled = false; let fallbackReason: string | undefined; let providerDurationMs: number | undefined; let providerUsage: unknown;
      if (rawOutputBytes === 0) diagnostics = "";
      else if (rawOutputBytes <= config.output.smallOutputBytes) diagnostics = rawStageOutput(executed, requested.batch, Boolean(request.question));
      else if (aggregateExitCode === 0 && !request.question) diagnostics = "";
      else {
        try {
          const summary = await (dependencies.provider ?? createOutputProvider(config.output)).summarize({
            question: request.question ?? DEFAULT_RUN_QUESTION,
            stages: executed.map(({ name, command, exitCode, stdout, stderr, terminationError }) => ({ name, command, exitCode, stdout, stderr, ...(terminationError ? { terminationError } : {}) })),
            targetOutputBytes: summaryTargetBytes,
            maxOutputBytes: summaryMaxBytes,
          });
          diagnostics = summary.text; distilled = true; providerDurationMs = summary.durationMs; providerUsage = summary.usage;
        } catch {
          header = requested.batch ? batchHeader(executed, "provider-error") : resultHeader(aggregateExitCode === 0 ? "PASS" : "FAIL", executed[0]!, "provider-error");
          diagnostics = rawStageOutput(executed, requested.batch, Boolean(request.question)); fallbackReason = "provider-error";
        }
      }
      const payload = [statuses, diagnostics].filter(Boolean).join("\n");
      const bounded = renderResult(header, payload, responseByteBudget);
      await writeTelemetry(resolveTelemetryDirectory(config.telemetry.directory, dependencies.telemetryDirectory), id, {
        ...base, durationMs: Date.now() - startedAt, commandDurationMs: executed.reduce((total, stage) => total + stage.durationMs, 0), stages: executed.map(({ name, command, exitCode, durationMs, stdout, stderr, terminationError }) => ({ name, command, exitCode, durationMs, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr), ...(terminationError ? { terminationError } : {}) })), ...(providerDurationMs !== undefined ? { providerDurationMs } : {}), ...(providerUsage ? { providerUsage } : {}),
        resolvedToolOutputTokenLimit: resolved.limit, toolOutputLimitSource: resolved.source, ...(resolved.configPath ? { toolOutputConfigPath: resolved.configPath } : {}), ...budget,
        exitCode: telemetryExitCode, stdoutBytes: executed.reduce((total, stage) => total + Buffer.byteLength(stage.stdout), 0), stderrBytes: executed.reduce((total, stage) => total + Buffer.byteLength(stage.stderr), 0), rawBytes: rawOutputBytes, resultBytes: Buffer.byteLength(bounded.text), compressionRatio: rawOutputBytes ? Number((Buffer.byteLength(bounded.text) / rawOutputBytes).toFixed(4)) : 1,
        resultCapped: bounded.capped, distilled, ...(fallbackReason ? { fallbackReason } : {}), result: bounded.text,
      });
      return bounded.text;
    } catch (error) {
      const result = `FAIL execution-error\n${error instanceof Error ? error.message : String(error)}`;
      await writeTelemetry(resolveTelemetryDirectory(config.telemetry.directory, dependencies.telemetryDirectory), id, { ...base, durationMs: Date.now() - startedAt, exitCode: null, stdoutBytes: executed.reduce((total, stage) => total + Buffer.byteLength(stage.stdout), 0), stderrBytes: executed.reduce((total, stage) => total + Buffer.byteLength(stage.stderr), 0), resultBytes: Buffer.byteLength(result), distilled: false, fallbackReason: "execution-error", result });
      return result;
    }
  };
}
