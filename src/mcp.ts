import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ContextRequest, ResolvedConfig, RunRequest } from "./config";
import { createContextHandler } from "./context";
import { createRunHandler } from "./run-command";

export const CONTEXT_DESCRIPTION = "Use after the capable agent understands the authoritative task but before broad repository discovery. Choose intent by the operation, not by words such as investigate, defect, changes, assess, or review: implement when code or configuration will change; advise for read-only investigation, diagnosis, explanation, or assessment of existing behavior; review only when the actual branch, PR, commit, diff, or working-tree changeset is itself the subject; merge only when unmerged conflicts are the subject. Do not choose review merely because the objective asks to explain or assess changes. Provide the complete retrieval objective and relevant task IDs, symbols, paths, branches, or issue references. Distill runs one deterministic Gortex over-gather and one tool-disabled Spark manifest-selection pass, then returns a flat bundle containing exact source, direct owners, directly governing boundaries and tests, and completed searches. Review and merge requests also include deterministic Git evidence. Treat included exact source as already read and make only targeted follow-up reads. Distill does not diagnose, advise, plan, review correctness, or replace task understanding. Skip narrow work that already has sufficient local context.";
export const RUN_DESCRIPTION = "Execute builds, tests, lint, type checks, formatting, logs, mechanical searches, and validation whose output may be large, noisy, or empty. Use command for one command or a genuinely dependent shell pipeline. Prefer commands for multi-stage validation: Distill runs named stages sequentially, continues after failures, and reports every real stage exit. Omit question for ordinary validation. Use it only for a short output-extraction requirement that differs from the default; never request exit status, restate stages, narrate why the command is running, or include parent-task history. Distill returns direct small output or one compact plain-text root-cause summary. It does not review correctness or replace exact source reading.";

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
export const RUN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["workspaceRoot"],
  oneOf: [{ required: ["command"] }, { required: ["commands"] }],
  properties: {
    workspaceRoot: { type: "string" },
    command: { type: "string", description: "One command or a genuinely dependent shell pipeline. Do not provide this together with commands." },
    commands: {
      type: "array",
      minItems: 1,
      maxItems: 32,
      description: "Named validation stages run sequentially in order. Every stage runs even when an earlier stage fails.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "command"],
        properties: { name: { type: "string" }, command: { type: "string" } },
      },
    },
    question: { type: "string", description: "Optional short extraction focus. Omit for ordinary validation. Never request exit status or include task narrative, prior work, exclusions, or repeated command stages." },
  },
};

function isContextRequest(value: unknown): value is ContextRequest {
  const request = value as Record<string, unknown> | undefined;
  return Boolean(request && request.action === "gather" && typeof request.workspaceRoot === "string" && typeof request.objective === "string" && ["implement", "advise", "review", "merge"].includes(String(request.intent)));
}
function isRunRequest(value: unknown): value is RunRequest {
  const request = value as Record<string, unknown> | undefined;
  if (!request || typeof request.workspaceRoot !== "string") return false;
  const hasCommand = typeof request.command === "string" && request.command.trim().length > 0;
  const commands = request.commands;
  const hasCommands = Array.isArray(commands) && commands.length > 0 && commands.length <= 32 && commands.every((stage) => {
    const item = stage as Record<string, unknown> | undefined;
    return Boolean(item && typeof item.name === "string" && item.name.trim() && typeof item.command === "string" && item.command.trim());
  });
  if (hasCommand === hasCommands) return false;
  if (!hasCommands) return true;
  const stages = commands as Array<{ name: string }>;
  return new Set(stages.map((stage) => stage.name.trim())).size === stages.length;
}

export function createMcpServer(config: ResolvedConfig): Server {
  const server = new Server({ name: "distill", version: "1" }, { capabilities: { tools: {} } });
  const context = createContextHandler(config); const run = createRunHandler(config);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: "context", description: CONTEXT_DESCRIPTION, inputSchema: CONTEXT_SCHEMA },
    { name: "run", description: RUN_DESCRIPTION, inputSchema: RUN_SCHEMA },
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
