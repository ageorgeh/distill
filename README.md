# distill

`distill` is a stdio MCP server with exactly two tools: `context` for one bounded Spark repository-discovery and source-reading pass, and `run` for bounded command output. It replaces the capable agent's initial broad repository exploration; it does not replace task understanding, implementation reasoning, review, edits, or correctness decisions.

## Context workflow

The capable agent reads and understands the authoritative task, review finding, specification, or merge request first. It then calls context gather with a complete repository-context objective. Spark performs the searches and reads that the capable agent would otherwise perform one command at a time. It returns only verified files and ranges, mechanical search locations, and validation commands. Distill reads the ranges from disk and returns their exact source in the same tool response.

Gather runs Spark exactly once and returns one flat, deduplicated source bundle. There are no indexes, concerns, dependencies, packets, or retrieval calls. Treat `EXACT SOURCE` as already read and do not repeat completed searches. Make only targeted follow-up reads when editing needs surrounding code or newly discovered details.

The normal target is about 10,000 tokens. Broad tasks may use the resolved one-tool hard budget, approximately 20,000 tokens when Codex is configured as shown below. Distill merges duplicate ranges, splits large ranges safely, distributes exact source across direct owners first, and degrades secondary material to precise `path:line-range` locations. It never creates follow-up context calls or fails merely because all candidate source does not fit. Telemetry retains the complete normalized candidate manifest and records which ranges were inlined.

```json
{
  "action": "gather",
  "workspaceRoot": "/home/alex/code/cmsWrapper/cms",
  "intent": "implement",
  "objective": "Gather repository implementation context for the accepted cleanup and durable-media follow-up fixes.",
  "references": ["backlog/current.md:48-end", "task-083"]
}
```

Invocation telemetry is stored under `.telemetry/invocations/` in the Distill installation root. It is gitignored, records the complete normalized source manifest and included/omitted ranges, and omits raw child-command output and full inline evidence.

## Command output

`run` executes builds, tests, lint, formatting, type checks, logs, and mechanical searches. It always returns an exit status. Small output is direct; large output is summarized within the resolved parent result budget. Successful validation is kept concise, while cascaded failures are collapsed to their shared root cause and a few representative failures. Provider output is semantically bounded on complete lines, never by clipping paths or diagnostics mid-item. On Unix, commands run through the user's login shell while retaining Distill's complete inherited environment. NixOS's child-shell environment guard is cleared so the login shell reloads the complete generated machine/session environment, rather than preserving a partially filtered MCP snapshot.

There is no pipeline interface: do not pipe output into Distill. Use `run` only for command output, not code review or exact-source reading.

## Configure

Keep `distill.config.ts` in the Distill installation. Context gathering is Codex/Spark-only; output compression supports Codex, local, Ollama, and OpenAI-compatible external providers.

```ts
import type { DistillConfig } from "./src/config";

export default {
  output: { provider: "codex", model: "gpt-5.3-codex-spark", codexCommand: "codex", timeoutMs: 180_000, smallOutputBytes: 2_000 },
  context: { provider: "codex", model: "gpt-5.3-codex-spark", codexCommand: "codex", reasoningEffort: "low", timeoutMs: 90_000, wrapUpAfterMs: 45_000, childToolOutputTokenLimit: 2_000, maxChildToolCalls: 30 },
  telemetry: { directory: ".telemetry" },
} satisfies DistillConfig;
```

The supplied context objective is quoted as the parent agent's task; Spark is instructed to retrieve source for that task, not solve it. `wrapUpAfterMs` and `maxChildToolCalls` are soft limits: Distill steers Spark to stop discovery and return its best verified manifest. `timeoutMs` is the hard deadline.

Repositories may add `.distill/config.toml`:

```toml
[context]
documentation_indexes = ["packages/modules/base/docs/llms.txt"]
default_base = "dev"
```

Global and repository `AGENTS.md` instructions should require capable agents to read authoritative tasks before `context` gather, treat its exact source as their initial read pass, and avoid repeating that discovery. This machine's global instructions and CMS root instructions follow that workflow.

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
tool_timeout_sec = 120
```

Set the top-level Codex result-history budget high enough for one broad context response:

```toml
tool_output_token_limit = 24000
```

```bash
distill mcp
distill context gather --intent implement --reference task-083 "Gather repository implementation context for the accepted durable-media fixes."
distill run "Report root causes and the exit code" -- pnpm run verify
```
