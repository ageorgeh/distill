import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ContextRequest, ResolvedConfig, RunRequest } from "./config";
import { createContextHandler } from "./context";
import { createRunHandler } from "./run-command";

export const CONTEXT_DESCRIPTION = "Use after the capable agent has read and understood the authoritative task, specification, review finding, or merge request, but before broad repository discovery. In gather mode provide a complete repository-context objective and task IDs, symbols, paths, branches, or issue references. Distill gathers implementation owners, callers, tests, documentation, completed searches, repository findings, and exact excerpts; it does not replace task understanding, source review, or correctness reasoning. The first result is a packet index from one completed Spark pass. Retrieve listed packets with packet mode before exploring or editing their concern; packet retrieval never reruns Spark. Skip for narrow work that already has sufficient local context.";
export const RUN_DESCRIPTION = "Execute builds, tests, lint, type checks, formatting, logs, mechanical searches, and validation whose output may be large, noisy, or empty. Distill returns deterministic exit status, direct small output, or a bounded root-cause summary. It does not review correctness or replace exact source reading.";

const contextSchema = { oneOf: [
  { type: "object", additionalProperties: false, required: ["action", "workspaceRoot", "intent", "objective"], properties: { action: { const: "gather" }, workspaceRoot: { type: "string" }, intent: { type: "string", enum: ["implement", "advise", "review", "merge"] }, objective: { type: "string" }, references: { type: "array", items: { type: "string" } }, inlineEvidence: { type: "string" }, baseRef: { type: "string" } } },
  { type: "object", additionalProperties: false, required: ["action", "contextId", "packetId"], properties: { action: { const: "packet" }, contextId: { type: "string" }, packetId: { type: "string" } } },
] };
const runSchema = { type: "object", additionalProperties: false, required: ["workspaceRoot", "command"], properties: { workspaceRoot: { type: "string" }, command: { type: "string" }, question: { type: "string" } } };

function isContextRequest(value: unknown): value is ContextRequest {
  const request = value as Record<string, unknown> | undefined;
  return Boolean(request && ((request.action === "gather" && typeof request.workspaceRoot === "string" && typeof request.objective === "string" && ["implement", "advise", "review", "merge"].includes(String(request.intent))) || (request.action === "packet" && typeof request.contextId === "string" && typeof request.packetId === "string")));
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
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const args = request.params.arguments;
      if (request.params.name === "context" && isContextRequest(args)) return { content: [{ type: "text", text: await context(args) }] };
      if (request.params.name === "run" && isRunRequest(args)) return { content: [{ type: "text", text: await run(args) }] };
      return { content: [{ type: "text", text: "Invalid Distill tool arguments." }], isError: true };
    } catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }; }
  });
  return server;
}

export async function serveMcp(config: ResolvedConfig): Promise<void> {
  await createMcpServer(config).connect(new StdioServerTransport());
}
