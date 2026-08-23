import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ContextRequest, ResolvedConfig, RunRequest } from "./config";
import { createContextHandler } from "./context";
import { createRunHandler } from "./run-command";

export const CONTEXT_DESCRIPTION = "Use after the capable agent understands the authoritative task but before broad repository discovery. Choose intent by the operation, not by words such as investigate, defect, changes, assess, or review: implement when code or configuration will change; advise for read-only investigation, diagnosis, explanation, or assessment of existing behavior; review only when the actual branch, PR, commit, diff, or working-tree changeset is itself the subject; merge only when unmerged conflicts are the subject. Do not choose review merely because the objective asks to explain or assess changes. Provide the complete retrieval objective and relevant task IDs, symbols, paths, branches, or issue references. Distill runs one deterministic Gortex over-gather and one tool-disabled Spark manifest-selection pass, then returns a flat bundle containing exact source, direct owners, directly governing boundaries and tests, and completed searches. Review and merge requests also include deterministic Git evidence. Treat included exact source as already read and make only targeted follow-up reads. Distill does not diagnose, advise, plan, review correctness, or replace task understanding. Skip narrow work that already has sufficient local context.";
export const RUN_DESCRIPTION = "Execute builds, tests, lint, type checks, formatting, logs, mechanical searches, and validation whose output may be large, noisy, or empty. Distill returns deterministic exit status, direct small output, or a bounded root-cause summary. It does not review correctness or replace exact source reading.";

export const CONTEXT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "workspaceRoot", "intent", "objective"],
  properties: {
    action: { const: "gather" },
    workspaceRoot: { type: "string" },
    intent: {
      type: "string",
      enum: ["implement", "advise", "review", "merge"],
      description: "Choose implement when code or configuration will change; advise for read-only investigation, diagnosis, explanation, or assessment of existing behavior; review only when the actual branch, PR, commit, diff, or working-tree changeset is itself the subject. Do not choose review merely because the objective says changes, assess, or review. Choose merge only when unmerged conflicts are the subject.",
    },
    objective: { type: "string" },
    references: { type: "array", items: { type: "string" } },
    inlineEvidence: { type: "string" },
    baseRef: { type: "string", description: "Base Git ref for review intent. Prefer a current remote-tracking ref such as origin/dev; Distill does not fetch remotes." },
  },
};
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
    { name: "context", description: CONTEXT_DESCRIPTION, inputSchema: CONTEXT_SCHEMA },
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
