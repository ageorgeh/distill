import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ContextRequest, ResolvedConfig, RunRequest } from "./config";
import { createContextHandler } from "./context";
import { createRunHandler } from "./run-command";

export const CONTEXT_DESCRIPTION = "Use after the capable agent understands the authoritative task but before broad repository discovery. Provide the complete retrieval objective and relevant task IDs, symbols, paths, branches, or issue references. Distill performs the initial searches and source reads once, then returns one flat, deduplicated bundle containing exact source, direct owners, boundary callers, representative tests, completed searches, and validation commands. Treat included exact source as already read and make only targeted follow-up reads. Distill does not diagnose, advise, plan, review correctness, or replace task understanding. Skip narrow work that already has sufficient local context.";
export const RUN_DESCRIPTION = "Execute builds, tests, lint, type checks, formatting, logs, mechanical searches, and validation whose output may be large, noisy, or empty. Distill returns deterministic exit status, direct small output, or a bounded root-cause summary. It does not review correctness or replace exact source reading.";

const contextSchema = { type: "object", additionalProperties: false, required: ["action", "workspaceRoot", "intent", "objective"], properties: { action: { const: "gather" }, workspaceRoot: { type: "string" }, intent: { type: "string", enum: ["implement", "advise", "review", "merge"] }, objective: { type: "string" }, references: { type: "array", items: { type: "string" } }, inlineEvidence: { type: "string" }, baseRef: { type: "string" } } };
const runSchema = { type: "object", additionalProperties: false, required: ["workspaceRoot", "command"], properties: { workspaceRoot: { type: "string" }, command: { type: "string" }, question: { type: "string" } } };

function isContextRequest(value: unknown): value is ContextRequest {
  const request = value as Record<string, unknown> | undefined;
  return Boolean(request && request.action === "gather" && typeof request.workspaceRoot === "string" && typeof request.objective === "string" && ["implement", "advise", "review", "merge"].includes(String(request.intent)));
}
function isRunRequest(value: unknown): value is RunRequest {
  const request = value as Partial<RunRequest> | undefined;
  return Boolean(request && typeof request.workspaceRoot === "string" && typeof request.command === "string");
}

export function createMcpServer(config: ResolvedConfig): Server {
  const server = new Server({ name: "distill", version: "1" }, { capabilities: { tools: {} } });
  const context = createContextHandler(config); const run = createRunHandler(config);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: "context", description: CONTEXT_DESCRIPTION, inputSchema: contextSchema },
    { name: "run", description: RUN_DESCRIPTION, inputSchema: runSchema },
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const args = request.params.arguments;
      if (request.params.name === "context" && isContextRequest(args)) return { content: [{ type: "text", text: await context(args, { signal: extra.signal }) }] };
      if (request.params.name === "run" && isRunRequest(args)) return { content: [{ type: "text", text: await run(args) }] };
      return { content: [{ type: "text", text: "Invalid Distill tool arguments." }], isError: true };
    } catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }; }
  });
  return server;
}

export async function serveMcp(config: ResolvedConfig): Promise<void> {
  await createMcpServer(config).connect(new StdioServerTransport());
}
