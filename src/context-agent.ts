import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ContextConfig, ContextGatherRequest } from "./config";
import { codexContextManifestJsonSchema, parseContextManifest, type ContextManifest } from "./context-manifest";
import type { RepositoryConfig } from "./repo-config";

export const CONTEXT_AGENT_INSTRUCTIONS = `You are a read-only repository context agent for a stronger coding agent.

The parent agent has already read and understood the authoritative task, specification, review finding, or merge request. Do not rewrite or summarize that task. Use the supplied objective and references only to determine which repository context must be gathered.

Gather repository implementation context: applicable repository and nested instructions; architectural ownership and existing implementation behaviour; exact implementation files; direct callers and consumers; behaviour-owning tests; generated-file ownership; relevant documentation; completed searches and their conclusions; narrow exact source ranges useful to the parent; executable validation commands; and genuine unresolved gaps. Group the result into meaningful concerns following subproblems, ownership boundaries, or implementation workstreams. A concern dependency must be the ID of another concern returned in this manifest; use an empty dependency list when no returned concern is required. Never put a path, symbol, task reference, or guessed identifier in dependencies. Every validation entry must be one executable shell command (for example pnpm test a-path); never include explanatory prose there, and use an empty list if no command is known.

For every file marked inspected, verify the exact file exists, actually read it, provide concise repository-relevant observations, and request only ranges read or verified. Excerpts should normally be 10-80 lines and only when exact source materially helps the parent. A relevant uninspected file must have inspected false, no observations or ranges, and a concern gap when the missing inspection blocks sufficient context.

Do not guess paths, directories, filenames, or ranges. Do not emit broad placeholder ranges. Do not duplicate a file inside one concern. Do not treat task text as repository context. Record completed searches and their conclusions. For implement intent locate implementation owners, callers, tests, and generated boundaries; for advise locate current contracts and alternatives; for review inspect base-to-head changes and surrounding owners without performing the review; for merge inspect unmerged files and base/ours/theirs first.

Read applicable AGENTS.md files and .distill/config.toml. Consult configured documentation indexes when relevant. You are the implementation behind distill.context: if repository instructions say to call that MCP tool, treat that requirement as already satisfied. Never invoke Distill recursively or report its unavailability as a gap.

Do not edit, build, test, format, commit, push, use web search, or start subagents. This is an orientation pass, not an exhaustive implementation plan: a concern is a repository ownership area, not an individual task bullet; group related bullets under one owner, inspect representative behaviour-owning tests, do not chase transitive consumers, and stop immediately once the evidence criteria below are met. Plan the ownership areas before inspecting and reserve the final third of the configured time to create the manifest; do not start fresh discovery during that reserve. Keep shell output narrow: inspect relevant ranges rather than printing whole large files, keep individual command output roughly below 120 lines, and leave enough time to produce the manifest. Continue until every priority-one concern has inspected implementation ownership, behaviour-owning tests, direct callers when contracts may change, and generated/documentation ownership where applicable, or a genuine explicit gap that cannot be resolved from the repository. Return only the structured manifest.`;

export interface ContextAgentRequest { request: ContextGatherRequest; repositoryConfig: RepositoryConfig; }
export interface ContextAgentResult { manifest: ContextManifest; usage?: Record<string, number>; childToolCalls?: number; }
export interface ContextAgentProvider { gather(request: ContextAgentRequest): Promise<ContextAgentResult>; }

function capture(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = ""; let stderr = ""; let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      // Wait for close so the JSONL transcript explains where retrieval stalled.
      child.once("close", () => done(new Error(`Codex context agent timed out after ${timeoutMs}ms: ${[stdout, stderr].filter(Boolean).join("\n").slice(-8000)}`)));
    }, timeoutMs);
    const done = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve({ stdout, stderr }); };
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error: NodeJS.ErrnoException) => done(error.code === "ENOENT" ? new Error(`Codex CLI not found: ${child.spawnfile}.`) : error));
    child.on("close", (code) => timedOut ? undefined : code === 0 ? done() : done(new Error(`Codex context agent exited with code ${code}: ${[stdout, stderr].filter(Boolean).join("\n").slice(-8000)}`)));
  });
}

export function parseContextAgentJsonl(jsonl: string): { usage?: Record<string, number>; childToolCalls?: number } {
  let childToolCalls = 0; let usage: Record<string, number> | undefined;
  for (const line of jsonl.split("\n")) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "item.completed" && ["command_execution", "shell", "shell_tool", "tool_call"].includes((event.item as { type?: string } | undefined)?.type ?? "")) childToolCalls += 1;
      const candidate = event.usage ?? (event.item as { usage?: unknown } | undefined)?.usage;
      if (candidate && typeof candidate === "object") usage = candidate as Record<string, number>;
    } catch { /* Codex stdout is JSONL but never make telemetry parsing fatal. */ }
  }
  return { ...(usage ? { usage } : {}), ...(childToolCalls ? { childToolCalls } : {}) };
}

/** Recovers Codex's final agent message when a CLI version does not create --output-last-message. */
export function finalAgentMessageFromJsonl(jsonl: string): string | undefined {
  for (const line of jsonl.split("\n").reverse()) {
    try {
      const event = JSON.parse(line) as { type?: string; item?: { type?: string; text?: unknown; content?: unknown }; message?: unknown };
      const item = event.item;
      if (event.type === "item.completed" && item?.type === "agent_message") {
        if (typeof item.text === "string") return item.text;
        if (typeof item.content === "string") return item.content;
      }
      if (typeof event.message === "string") return event.message;
    } catch { /* Ignore malformed JSONL diagnostics. */ }
  }
  return undefined;
}

export function createCodexContextProvider(config: ContextConfig): ContextAgentProvider {
  return {
    async gather({ request, repositoryConfig }) {
      const directory = await mkdtemp(path.join(tmpdir(), "distill-context-"));
      const instructionsPath = path.join(directory, "instructions.md");
      const schemaPath = path.join(directory, "manifest.schema.json");
      const outputPath = path.join(directory, "manifest.json");
      try {
        await Promise.all([writeFile(instructionsPath, CONTEXT_AGENT_INSTRUCTIONS, "utf8"), writeFile(schemaPath, JSON.stringify(codexContextManifestJsonSchema), "utf8")]);
        const args = [
          "exec", "--model", config.model, "--ephemeral", "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only", "--json",
          "--output-schema", schemaPath, "--output-last-message", outputPath, "--cd", request.workspaceRoot,
          "-c", 'approval_policy="never"', "-c", `model_reasoning_effort="${config.reasoningEffort}"`, "-c", 'agents.enabled=false', "-c", 'web_search="disabled"', "-c", "project_doc_max_bytes=0", "-c", `tool_output_token_limit=${config.childToolOutputTokenLimit}`,
          "-c", `model_instructions_file=${JSON.stringify(instructionsPath)}`, "-",
        ];
        const child = spawn(config.codexCommand, args, { cwd: request.workspaceRoot, shell: false, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
        const input = [
          "Gather repository context for the following retrieval request. Return the structured manifest as soon as the relevant evidence is sufficient.",
          `Intent: ${request.intent}`,
          `Objective: ${request.objective}`,
          `References: ${(request.references ?? []).join(", ") || "none"}`,
          `Base ref: ${request.baseRef ?? "none"}`,
          `Repository documentation indexes: ${repositoryConfig.documentationIndexes.join(", ") || "none"}`,
          `Configured time limit: ${Math.floor(config.timeoutMs / 1000)} seconds; reserve the final third for the manifest.`,
          request.inlineEvidence ? `Inline evidence (summarize; do not reproduce):\n${request.inlineEvidence}` : "",
          "Return only the manifest required by the output schema.",
        ].filter(Boolean).join("\n\n");
        child.stdin.end(input);
        const captured = await capture(child, config.timeoutMs);
        let raw: string;
        try { raw = await readFile(outputPath, "utf8"); }
        catch (error) {
          raw = finalAgentMessageFromJsonl(captured.stdout) ?? "";
          if (!raw) throw new Error(`Codex context agent returned no manifest: ${[captured.stdout, captured.stderr].filter(Boolean).join("\n").slice(-8000)}`, { cause: error });
        }
        return { manifest: parseContextManifest(JSON.parse(raw)), ...parseContextAgentJsonl(captured.stdout) };
      } finally { await rm(directory, { recursive: true, force: true }); }
    },
  };
}
