# distill

`distill` is a stdio MCP server for repository context retrieval and bounded command execution. It keeps broad repository inspection and noisy command output out of a capable agent's main context.

## Configure

Create `distill.config.ts` beside where you run Distill:

```ts
import type { DistillConfig } from "./src/config";

export default {
  output: { provider: "codex", model: "gpt-5.3-codex-spark", codexCommand: "codex", timeoutMs: 180_000, smallOutputBytes: 2_000 },
  context: { provider: "codex", model: "gpt-5.3-codex-spark", codexCommand: "codex", reasoningEffort: "medium", timeoutMs: 240_000, childToolOutputTokenLimit: 8_000 },
  telemetry: { directory: ".telemetry" },
} satisfies DistillConfig;
```

Local, Ollama, and OpenAI-compatible external providers remain available for `output`; context gathering currently uses Codex/Spark.

### Linux prerequisite

Context gathering uses Codex's read-only Bubblewrap sandbox. Codex must be launched without inherited Linux capabilities: do not apply `security.wrappers.*.capabilities` to the globally used Node executable. A capability-bearing Node process makes Bubblewrap reject child shell commands with `Unexpected capabilities but not setuid`.

## MCP

```toml
[mcp_servers.distill]
command = "distill"
args = ["mcp"]
cwd = "/home/alex/code/distill"
required = true
enabled_tools = ["context", "run"]
tool_timeout_sec = 300
```

The server exposes exactly two tools:

- `context` — use before broad, architectural, cross-module, review, merge, or unclear work. Supply a short retrieval objective and repository references; use `inlineEvidence` only for source text that is absent from the repository.
- `run` — executes a command in the target workspace, returns its deterministic status, and compresses only large output.

Pass task IDs, paths, symbols, branches, or tests by reference rather than copying repository-backed requirements. Keep reviewer orchestration, reporting instructions, and the final response in the parent agent.

For a backlog task, request context with `objective: "Prepare the repository context required to implement task 083 completely."` and `references: ["task-083"]`. A review agent should make its own `review` request against the task reference and base branch rather than receiving a packet copied from the implementation agent. For a pasted review finding, include just the finding in `inlineEvidence`; Distill digests it and does not repeat it in the packet.

Repositories can optionally provide `.distill/config.toml`:

```toml
[context]
documentation_indexes = ["packages/modules/base/docs/llms.txt"]
default_base = "dev"
```

## CLI

```bash
distill mcp
distill context --intent implement --reference task-083 "Prepare the repository context required to implement task 083 completely."
distill context --intent review --reference task-083 --base-ref dev "Gather evidence for reviewing the current branch."
distill run "Report failures with paths and line numbers" -- pnpm lint
```

`distill run` reports silent commands explicitly. Small output is returned exactly; large output is summarized. If a provider fails, Distill returns a bounded head/tail extract rather than raw output. Runtime telemetry is written to gitignored `.telemetry/` without raw command output or full inline evidence.

The normal launcher places `.telemetry/` in the Distill installation/repository root, not the target workspace.
