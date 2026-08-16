import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { ContextGatherRequest, ContextRequest, ResolvedConfig } from "./config";
import { resolveToolOutputTokenLimit, resultBudget, type ResolvedToolOutputLimit } from "./codex-config";
import { createCodexContextProvider, type ContextAgentProvider } from "./context-agent";
import { buildContextBundle } from "./context-packet";
import { readContextPacket, writeContextBundle } from "./context-store";
import { readRepositoryConfig } from "./repo-config";
import { resolveTelemetryDirectory, telemetryId, writeTelemetry } from "./telemetry";

export interface ContextHandlerDependencies {
  provider?: ContextAgentProvider;
  resolveLimit?: () => Promise<ResolvedToolOutputLimit>;
  telemetryDirectory?: string;
}

function limitTelemetry(resolved: ResolvedToolOutputLimit) {
  return { resolvedToolOutputTokenLimit: resolved.limit, toolOutputLimitSource: resolved.source, ...(resolved.configPath ? { toolOutputConfigPath: resolved.configPath } : {}) };
}

export function createContextHandler(config: ResolvedConfig, dependencies: ContextHandlerDependencies = {}) {
  return async (request: ContextRequest): Promise<string> => {
    const telemetryRoot = resolveTelemetryDirectory(config.telemetry.directory, dependencies.telemetryDirectory);
    if (request.action === "packet") {
      const startedAt = Date.now();
      try {
        const result = await readContextPacket(telemetryRoot, request.contextId, request.packetId);
        await writeTelemetry(telemetryRoot, telemetryId(), { mode: "context-packet", contextId: request.contextId, packetId: request.packetId, durationMs: Date.now() - startedAt, resultBytes: Buffer.byteLength(result), providerInvoked: false });
        return result;
      } catch (error) {
        await writeTelemetry(telemetryRoot, telemetryId(), { mode: "context-packet", contextId: request.contextId, packetId: request.packetId, durationMs: Date.now() - startedAt, providerInvoked: false, failure: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }
    return gather(config, request, dependencies, telemetryRoot);
  };
}

async function gather(config: ResolvedConfig, request: ContextGatherRequest, dependencies: ContextHandlerDependencies, telemetryRoot: string): Promise<string> {
  const contextId = telemetryId(); const startedAt = Date.now();
  const base = {
    mode: "context-gather" as const, contextId, workspaceRoot: request.workspaceRoot, intent: request.intent, objective: request.objective,
    references: request.references ?? [], inlineEvidenceBytes: Buffer.byteLength(request.inlineEvidence ?? ""),
    ...(request.inlineEvidence ? { inlineEvidenceHash: createHash("sha256").update(request.inlineEvidence).digest("hex") } : {}),
    ...(request.baseRef ? { baseRef: request.baseRef } : {}), provider: config.context.provider, model: config.context.model,
  };
  try {
    if (!path.isAbsolute(request.workspaceRoot)) throw new Error("workspaceRoot must be an absolute path.");
    const workspaceRoot = await realpath(request.workspaceRoot);
    const [repositoryConfig, resolved] = await Promise.all([readRepositoryConfig(workspaceRoot), (dependencies.resolveLimit ?? resolveToolOutputTokenLimit)()]);
    const budget = resultBudget(resolved);
    const effectiveRequest: ContextGatherRequest = { ...request, workspaceRoot, ...(request.baseRef || !repositoryConfig.defaultBase ? {} : { baseRef: repositoryConfig.defaultBase }) };
    const response = await (dependencies.provider ?? createCodexContextProvider(config.context)).gather({ request: effectiveRequest, repositoryConfig });
    const built = await buildContextBundle({ contextId, workspaceRoot, manifest: response.manifest, resultByteBudget: budget.resultByteBudget });
    const bundlePath = await writeContextBundle(telemetryRoot, built.bundle);
    const returned = built.bundle.packets.find((packet) => packet.id === "index-1");
    if (!returned) throw new Error("Context bundle did not produce an index packet.");
    await writeTelemetry(telemetryRoot, contextId, {
      ...base, durationMs: Date.now() - startedAt, ...(response.usage ? { providerUsage: response.usage } : {}), childCommandCalls: response.childToolCalls ?? 0,
      ...limitTelemetry(resolved), ...budget, manifestValidation: built.normalization, concernCount: built.bundle.manifest.concerns.length, packetCount: built.bundle.packets.length,
      packetIndex: built.bundle.packets.map(({ id, concernId, part, parts, bytes, requiredBefore, dependencies: packetDependencies }) => ({ id, concernId, part, parts, bytes, requiredBefore, dependencies: packetDependencies })),
      returnedPacketId: returned.id, returnedPacketBytes: returned.bytes, bundlePath,
    });
    return returned.text;
  } catch (error) {
    await writeTelemetry(telemetryRoot, contextId, { ...base, durationMs: Date.now() - startedAt, failure: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
