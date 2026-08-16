# distill

`distill` is a stdio MCP server with exactly two tools: `context` for one bounded Spark repository-discovery pass and `run` for bounded command output. It reduces context cost; it does not replace the capable agent's task understanding, exact source reading, review, edits, or correctness decisions.

## Context workflow

The capable agent reads and understands the authoritative task, review finding, specification, or merge request first. It then calls context gather with a complete repository-context objective. Spark gathers repository facts only: inspected owners, callers, tests, generated boundaries, documentation, completed searches, exact excerpts, executable validation, and genuine gaps. It must not return a rewritten task.

Gather runs Spark exactly once and returns `index-1`. The index lists global and concern packets. Fetch packets marked required before any edit before editing; before working on a concern, fetch its packets and dependency packets. Packet retrieval reads the stored bundle and never reruns Spark, including after an MCP-server restart. Do not repeat `SEARCHES DONE`, broadly reread `INSPECTED`, or reread `EXACT SOURCE`; use targeted reads only for an identified gap.

Large context is split by semantic concerns rather than truncated. Packets use `INSPECTED` for files Spark read and what it found, `SEARCHES DONE` for already-completed discovery, `EXACT SOURCE` for complete labelled source ranges, `RELATED` for relevant uninspected paths, and `GAPS` only for real unresolved repository evidence.

```json
{
  "action": "gather",
  "workspaceRoot": "/home/alex/code/cmsWrapper/cms",
  "intent": "implement",
  "objective": "Gather repository implementation context for the accepted cleanup and durable-media follow-up fixes.",
  "references": ["backlog/current.md:48-end", "task-083"]
}
```

```json
{
  "action": "packet",
  "contextId": "<context-id-from-index>",
  "packetId": "cleanup-fencing-1"
}
```

Bundles are functional state, stored atomically under `.telemetry/contexts/<context-id>/bundle.json` in the Distill installation root. Invocation telemetry is under `.telemetry/invocations/`; it is gitignored and omits raw command output and full inline evidence.

## Command output

`run` executes builds, tests, lint, formatting, type checks, logs, and mechanical searches. It always returns an exit status. Small output is direct; large output is summarized within the resolved parent result budget. Successful validation is kept concise, while cascaded failures are collapsed to their shared root cause and a few representative failures. Provider output is semantically bounded on complete lines, never by clipping paths or diagnostics mid-item.

There is no pipeline interface: do not pipe output into Distill. Use `run` only for command output, not code review or exact-source reading.

## Configure

Keep `distill.config.ts` in the Distill installation. Context gathering is Codex/Spark-only; output compression supports Codex, local, Ollama, and OpenAI-compatible external providers.

```ts
import type { DistillConfig } from "./src/config";

export default {
  output: { provider: "codex", model: "gpt-5.3-codex-spark", codexCommand: "codex", timeoutMs: 180_000, smallOutputBytes: 2_000 },
  context: { provider: "codex", model: "gpt-5.3-codex-spark", codexCommand: "codex", reasoningEffort: "low", timeoutMs: 300_000, childToolOutputTokenLimit: 2_000 },
  telemetry: { directory: ".telemetry" },
} satisfies DistillConfig;
```

Repositories may add `.distill/config.toml`:

```toml
[context]
documentation_indexes = ["packages/modules/base/docs/llms.txt"]
default_base = "dev"
```

Global and repository `AGENTS.md` instructions should require capable agents to read authoritative tasks before `context` gather, then use the packet index before broad discovery. This repository's Nix-managed global instructions and CMS root instructions follow that workflow.

### Linux prerequisite

Context gathering uses Codex's read-only Bubblewrap sandbox. Launch Codex without inherited Linux capabilities: do not apply `security.wrappers.*.capabilities` to the globally used Node executable. A capability-bearing Node process makes Bubblewrap reject child shell commands with `Unexpected capabilities but not setuid`.

## MCP and CLI

```toml
[mcp_servers.distill]
command = "distill"
args = ["mcp"]
cwd = "/home/alex/code/distill"
required = true
enabled_tools = ["context", "run"]
tool_timeout_sec = 300
```

```bash
distill mcp
distill context gather --intent implement --reference task-083 "Gather repository implementation context for the accepted durable-media fixes."
distill context packet <context-id> <packet-id>
distill run "Report root causes and the exit code" -- pnpm run verify
```
