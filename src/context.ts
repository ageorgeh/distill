import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { ContextRequest, ResolvedConfig } from "./config";
import { resolveToolOutputTokenLimit, resultBudget } from "./codex-config";
import { createCodexContextProvider, type ContextAgentProvider } from "./context-agent";
import { assembleContextPacket } from "./context-packet";
import { readRepositoryConfig } from "./repo-config";
import { resolveTelemetryDirectory, telemetryId, writeTelemetry } from "./telemetry";

export interface ContextHandlerDependencies { provider?: ContextAgentProvider; resolveLimit?: () => Promise<number>; telemetryDirectory?: string; }

export function createContextHandler(config: ResolvedConfig, dependencies: ContextHandlerDependencies = {}) {
  return async (request: ContextRequest): Promise<string> => {
    const id = telemetryId(); const startedAt = Date.now();
    const base = { id, timestamp: new Date().toISOString(), mode: "context" as const, workspaceRoot: request.workspaceRoot, intent: request.intent, objective: request.objective, references: request.references ?? [], inlineEvidenceBytes: Buffer.byteLength(request.inlineEvidence ?? ""), ...(request.inlineEvidence ? { inlineEvidenceHash: createHash("sha256").update(request.inlineEvidence).digest("hex") } : {}), ...(request.baseRef ? { baseRef: request.baseRef } : {}), provider: config.context.provider, model: config.context.model };
    try {
      if (!path.isAbsolute(request.workspaceRoot)) throw new Error("workspaceRoot must be an absolute path.");
      const workspaceRoot = await realpath(request.workspaceRoot);
      const repositoryConfig = await readRepositoryConfig(workspaceRoot);
      const resolved = await (dependencies.resolveLimit ?? resolveToolOutputTokenLimit)();
      const budget = resultBudget(resolved);
      const effectiveRequest = { ...request, workspaceRoot, ...(request.baseRef || !repositoryConfig.defaultBase ? {} : { baseRef: repositoryConfig.defaultBase }) };
      const response = await (dependencies.provider ?? createCodexContextProvider(config.context)).gather({ request: effectiveRequest, repositoryConfig });
      const assembled = await assembleContextPacket({ id, workspaceRoot, manifest: response.manifest, resultByteBudget: budget.resultByteBudget });
      await writeTelemetry(resolveTelemetryDirectory(config.telemetry.directory, dependencies.telemetryDirectory), id, { ...base, durationMs: Date.now() - startedAt, ...(response.usage ? { usage: response.usage } : {}), ...(response.childToolCalls ? { childToolCalls: response.childToolCalls } : {}), resolvedToolOutputTokenLimit: resolved, ...budget, manifest: response.manifest, ...(assembled.invalidEntries.length ? { manifestValidationErrors: assembled.invalidEntries } : {}), packetBytes: Buffer.byteLength(assembled.packet), packet: assembled.packet });
      return assembled.packet;
    } catch (error) {
      await writeTelemetry(resolveTelemetryDirectory(config.telemetry.directory, dependencies.telemetryDirectory), id, { ...base, durationMs: Date.now() - startedAt, failure: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };
}
