import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { ContextGatherRequest, ResolvedConfig } from "./config";
import { resolveToolOutputTokenLimit, resultBudget, type ResolvedToolOutputLimit } from "./codex-config";
import { createCodexContextProvider, type ContextAgentProvider } from "./context-agent";
import { buildContextSourcePack } from "./context-source-pack";
import { readRepositoryConfig } from "./repo-config";
import { resolveTelemetryDirectory, telemetryId, writeTelemetry } from "./telemetry";

export interface ContextHandlerDependencies {
  provider?: ContextAgentProvider;
  resolveLimit?: () => Promise<ResolvedToolOutputLimit>;
  telemetryDirectory?: string;
}
export interface ContextHandlerOptions { signal?: AbortSignal; }

function limitTelemetry(resolved: ResolvedToolOutputLimit) {
  return { resolvedToolOutputTokenLimit: resolved.limit, toolOutputLimitSource: resolved.source, ...(resolved.configPath ? { toolOutputConfigPath: resolved.configPath } : {}) };
}

export function createContextHandler(config: ResolvedConfig, dependencies: ContextHandlerDependencies = {}) {
  return async (request: ContextGatherRequest, options: ContextHandlerOptions = {}): Promise<string> => {
    const telemetryRoot = resolveTelemetryDirectory(config.telemetry.directory, dependencies.telemetryDirectory);
    return gather(config, request, dependencies, telemetryRoot, options);
  };
}

async function gather(config: ResolvedConfig, request: ContextGatherRequest, dependencies: ContextHandlerDependencies, telemetryRoot: string, options: ContextHandlerOptions): Promise<string> {
  const contextId = telemetryId(); const startedAt = Date.now();
  let phase = "validate-request";
  let response: Awaited<ReturnType<ContextAgentProvider["gather"]>> | undefined;
  let resolved: ResolvedToolOutputLimit | undefined;
  let budget: ReturnType<typeof resultBudget> | undefined;
  let normalization: string[] | undefined;
  const base = {
    mode: "context-gather" as const, contextId, workspaceRoot: request.workspaceRoot, intent: request.intent, objective: request.objective,
    references: request.references ?? [], inlineEvidenceBytes: Buffer.byteLength(request.inlineEvidence ?? ""),
    ...(request.inlineEvidence ? { inlineEvidenceHash: createHash("sha256").update(request.inlineEvidence).digest("hex") } : {}),
    ...(request.baseRef ? { baseRef: request.baseRef } : {}), provider: config.context.provider, model: config.context.model,
  };
  try {
    if (!path.isAbsolute(request.workspaceRoot)) throw new Error("workspaceRoot must be an absolute path.");
    const workspaceRoot = await realpath(request.workspaceRoot);
    phase = "resolve-config";
    const [repositoryConfig, resolvedLimit] = await Promise.all([readRepositoryConfig(workspaceRoot), (dependencies.resolveLimit ?? resolveToolOutputTokenLimit)()]);
    resolved = resolvedLimit;
    budget = resultBudget(resolved);
    const effectiveRequest: ContextGatherRequest = { ...request, workspaceRoot, ...(request.baseRef || !repositoryConfig.defaultBase ? {} : { baseRef: repositoryConfig.defaultBase }) };
    phase = "provider";
    response = await (dependencies.provider ?? createCodexContextProvider(config.context)).gather({ request: effectiveRequest, repositoryConfig }, { signal: options.signal });
    phase = "assemble-source-pack";
    const built = await buildContextSourcePack({ contextId, workspaceRoot, manifest: response.manifest, resultByteBudget: budget.resultByteBudget });
    normalization = built.normalization;
    await writeTelemetry(telemetryRoot, contextId, {
      ...base, durationMs: Date.now() - startedAt, ...(response.usage ? { providerUsage: response.usage } : {}), childCommandCalls: response.childToolCalls ?? 0,
      wrapUpPromptSent: response.wrapUpPromptSent ?? false,
      ...(response.wrapUpReason ? { wrapUpReason: response.wrapUpReason } : {}),
      ...limitTelemetry(resolved), ...budget, targetResultByteBudget: built.targetByteBudget, hardResultByteBudget: built.hardByteBudget,
      broadContext: built.broad, manifestValidation: built.normalization, sourceManifest: built.manifest,
      includedSources: built.includedSources, omittedSources: built.omittedSources, resultBytes: built.bytes,
    });
    return built.text;
  } catch (error) {
    await writeTelemetry(telemetryRoot, contextId, {
      ...base,
      durationMs: Date.now() - startedAt,
      failurePhase: phase,
      failure: error instanceof Error ? error.message : String(error),
      ...(response?.usage ? { providerUsage: response.usage } : {}),
      ...(response ? { childCommandCalls: response.childToolCalls ?? 0, wrapUpPromptSent: response.wrapUpPromptSent ?? false, ...(response.wrapUpReason ? { wrapUpReason: response.wrapUpReason } : {}) } : {}),
      ...(resolved ? limitTelemetry(resolved) : {}),
      ...(budget ?? {}),
      ...(normalization ? { manifestValidation: normalization } : {}),
    });
    throw error;
  }
}
