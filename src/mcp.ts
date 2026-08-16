import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ContextRequest, ResolvedConfig, RunRequest } from "./config";
import { createContextHandler } from "./context";
import { createRunHandler } from "./run-command";

export const CONTEXT_DESCRIPTION = "Use before moderate, broad, architectural, cross-module, review, merge, or unclear repository work. Convert the user request into a retrieval-only objective. Pass repository-backed requirements by task ID, path, symbol, branch, or other reference rather than copying them. Include inlineEvidence only for source text unavailable in the repository. Do not pass reporting instructions, requested response formatting, reviewer orchestration, or other work the parent agent remains responsible for. Skip this tool for narrow tasks that already identify the exact file and local behaviour unless callers, tests, or architectural impact are unclear.";
export const RUN_DESCRIPTION = "Use to execute builds, tests, linting, type checks, searches, logs, diffs, and other commands whose output may be large, noisy, or empty. Distill always returns the command exit status and enough information to avoid rerunning a silent or already-understandable command.";

const contextSchema = { type: "object", additionalProperties: false, required: ["workspaceRoot", "intent", "objective"], properties: { workspaceRoot: { type: "string" }, intent: { type: "string", enum: ["implement", "advise", "review", "merge"] }, objective: { type: "string" }, references: { type: "array", items: { type: "string" } }, inlineEvidence: { type: "string" }, baseRef: { type: "string" } } };
const runSchema = { type: "object", additionalProperties: false, required: ["workspaceRoot", "command"], properties: { workspaceRoot: { type: "string" }, command: { type: "string" }, question: { type: "string" } } };

function isContextRequest(value: unknown): value is ContextRequest {
  const request = value as Partial<ContextRequest> | undefined;
  return Boolean(request && typeof request.workspaceRoot === "string" && typeof request.objective === "string" && ["implement", "advise", "review", "merge"].includes(request.intent ?? ""));
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
