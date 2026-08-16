import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ContextConfig, ContextRequest } from "./config";
import { codexContextManifestJsonSchema, parseContextManifest, type ContextManifest } from "./context-manifest";
import type { RepositoryConfig } from "./repo-config";

const INSTRUCTIONS = `You are a read-only repository context agent for a stronger coding agent.

Gather the smallest complete set of repository evidence needed for the parent agent to begin the requested implementation, advice, review, or merge work correctly. Resolve and read supplied references first. For a broad task, work in evidence order: task contract and applicable instructions; targeted symbols/paths named by that contract; their direct callers and behavior-owning tests; then validation commands and gaps. Batch related reads and searches. The 16-command limit is strict: a command may inspect several directly related files, but after the sixteenth command stop inspecting and return the manifest with any remaining uncertainty as gaps. Do not enumerate the repository or read files unrelated to a named task requirement. In the manifest files list, provide only existing exact file paths, never directories, globs, or guessed paths; mention an unresolved directory or ownership question only in gaps. Return once you can provide a compact contract, ordered workstreams, edit/caller/test map, key risks, validation, and explicit gaps; do not spend time pursuing exhaustive coverage. Use the available time when it adds directly relevant evidence, but return before the execution timeout. If a shell command fails because the sandbox is unavailable, record that exact failure as a gap and return immediately; do not retry shell commands. Do not implement, edit files, run builds, run tests, format files, commit, push, or start subagents. Use shell commands only for read-only repository inspection. Resolve supplied references first. Read applicable AGENTS.md files and repository instructions. Read .distill/config.toml when present and consult configured documentation indexes when applicable. You are the implementation behind distill.context: if repository instructions say to call that MCP tool, treat that requirement as already satisfied. Never invoke Distill recursively or report its unavailability as a gap.

Digest long task files; do not copy them. Identify rules, architectural requirements, acceptance criteria, exclusions, ordered workstreams, likely edit owners, direct callers, behaviour-owning tests, generated-file ownership, relevant examples, validation commands, risks, and explicit gaps. For review inspect the base-to-head change; for merge inspect unmerged files first. Stop once evidence is sufficient. Return only the required structured manifest.`;

export interface ContextAgentRequest { request: ContextRequest; repositoryConfig: RepositoryConfig; }
export interface ContextAgentResult { manifest: ContextManifest; usage?: Record<string, number>; childToolCalls?: number; }
export interface ContextAgentProvider { gather(request: ContextAgentRequest): Promise<ContextAgentResult>; }

function capture(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = ""; let stderr = ""; let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      // Wait for close so the JSONL transcript explains where retrieval stalled.
      child.once("close", () => done(new Error(`Codex context agent timed out after ${timeoutMs}ms: ${[stdout, stderr].filter(Boolean).join("\n").slice(-8000)}`)));
    }, timeoutMs);
    const done = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve({ stdout, stderr }); };
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error: NodeJS.ErrnoException) => done(error.code === "ENOENT" ? new Error(`Codex CLI not found: ${child.spawnfile}.`) : error));
    child.on("close", (code) => code === 0 ? done() : done(new Error(`Codex context agent exited with code ${code}: ${[stdout, stderr].filter(Boolean).join("\n").slice(-8000)}`)));
  });
}

function parseUsage(jsonl: string): { usage?: Record<string, number>; childToolCalls?: number } {
  let childToolCalls = 0; let usage: Record<string, number> | undefined;
  for (const line of jsonl.split("\n")) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "item.completed" && (event.item as { type?: string } | undefined)?.type === "tool_call") childToolCalls += 1;
      const candidate = event.usage ?? (event.item as { usage?: unknown } | undefined)?.usage;
      if (candidate && typeof candidate === "object") usage = candidate as Record<string, number>;
    } catch { /* Codex stdout is JSONL but never make telemetry parsing fatal. */ }
  }
  return { ...(usage ? { usage } : {}), ...(childToolCalls ? { childToolCalls } : {}) };
}

export function createCodexContextProvider(config: ContextConfig): ContextAgentProvider {
  return {
    async gather({ request, repositoryConfig }) {
      const directory = await mkdtemp(path.join(tmpdir(), "distill-context-"));
      const instructionsPath = path.join(directory, "instructions.md");
      const schemaPath = path.join(directory, "manifest.schema.json");
      const outputPath = path.join(directory, "manifest.json");
      try {
        await Promise.all([writeFile(instructionsPath, INSTRUCTIONS, "utf8"), writeFile(schemaPath, JSON.stringify(codexContextManifestJsonSchema), "utf8")]);
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
          request.inlineEvidence ? `Inline evidence (summarize; do not reproduce):\n${request.inlineEvidence}` : "",
          "Return only the manifest required by the output schema.",
        ].filter(Boolean).join("\n\n");
        child.stdin.end(input);
        const captured = await capture(child, config.timeoutMs);
        let raw: string;
        try { raw = await readFile(outputPath, "utf8"); }
        catch (error) {
          throw new Error(`Codex context agent returned no manifest: ${[captured.stdout, captured.stderr].filter(Boolean).join("\n").slice(-8000)}`, { cause: error });
        }
        return { manifest: parseContextManifest(JSON.parse(raw)), ...parseUsage(captured.stdout) };
      } finally { await rm(directory, { recursive: true, force: true }); }
    },
  };
}
