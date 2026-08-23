# distill

`distill` is a stdio MCP server with exactly two tools: `context` for deterministic Gortex discovery followed by one bounded Spark evidence-selection pass, and `run` for bounded command output. It replaces the capable agent's initial broad repository exploration; it does not replace task understanding, implementation reasoning, review, edits, or correctness decisions.

## Context workflow

The capable agent reads and understands the authoritative task, review finding, specification, or merge request first. It then calls context gather with a complete repository-context objective. Distill runs one generous graph-only `gortex explore` in TOON format, always adds bounded exact excerpts for readable explicit file references, and gives that precomputed candidate context to Spark. Supplied inline evidence participates in the Gortex query. Configured documentation indexes are read deterministically and included as bounded candidate evidence. Review requests add the deterministic base-to-HEAD changed files and patch; merge requests add unmerged files and conflict patches. Those Git files are mandatory Gortex seeds. Spark only selects verified files and ranges; it has no shell or graph tools. Distill reads the selected ranges from disk and returns their exact source in the same tool response.

Gather runs Gortex once and Spark exactly once, with no discovery follow-up, and returns one flat, deduplicated source bundle. The target repository must already be tracked by the shared Gortex daemon. Treat `EXACT SOURCE` as already read and do not repeat completed searches. Make only targeted follow-up reads when editing needs surrounding code or newly discovered details.

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

`run` executes builds, tests, lint, formatting, type checks, logs, and mechanical searches. It always starts with a compact deterministic status such as `PASS exit=0` or `FAIL exit=1`. Small output is returned directly; large output is summarized as plain agent-to-agent lines without Markdown, emoji, conversational framing, or repeated status. Ordinary summaries target 2,000 bytes and may grow to 8,000 bytes for independent actionable failures. Cascaded failures are collapsed to their shared root cause and a few representative failures. Paths and diagnostics are kept whole; lower-priority findings are omitted instead of shortened with ellipses. Summarization provenance remains in telemetry, while exceptional response flags such as `provider-error`, `timeout`, and `truncated` are exposed when relevant. On Unix, commands run through the user's login shell while retaining Distill's complete inherited environment. NixOS's child-shell environment guard is cleared so the login shell reloads the complete generated machine/session environment, rather than preserving a partially filtered MCP snapshot.

There is no pipeline interface: do not pipe output into Distill. Use `run` only for command output, not code review or exact-source reading.

## Configure

Keep `distill.config.ts` in the Distill installation. Context gathering is Codex/Spark-only; output compression supports Codex, local, Ollama, and OpenAI-compatible external providers.

```ts
import type { DistillConfig } from "./src/config";

export default {
  output: { provider: "codex", model: "gpt-5.3-codex-spark", codexCommand: "codex", timeoutMs: 180_000, smallOutputBytes: 2_000 },
  context: { provider: "codex", model: "gpt-5.3-codex-spark", codexCommand: "codex", reasoningEffort: "low", timeoutMs: 90_000, gortexCommand: "gortex", gortexTimeoutMs: 60_000, gortexMaxSymbols: 100, gortexMaxOutputBytes: 200_000 },
  telemetry: { directory: ".telemetry" },
} satisfies DistillConfig;
```

The supplied context objective is quoted as the parent agent's task. Gortex performs deterministic over-gathering with no LLM provider; Spark receives the result as inert candidate evidence and performs one tool-disabled manifest-selection inference rather than a repository-discovery loop. `gortexMaxSymbols` defaults to 100, `gortexMaxOutputBytes` defaults to 200,000 bytes (about 50,000 tokens), `gortexTimeoutMs` defaults to 60 seconds, and `timeoutMs` is Spark's hard deadline. `gortexCommand` may select a non-standard CLI path.

For review retrieval, Distill keeps the complete changed-file list and bounded committed/working-tree patch as mandatory Spark evidence. Gortex receives at most 24 deterministic graph seeds selected across changed implementation, contract, test, and documentation areas, plus a compact changed-area digest. Generated and snapshot-like files are omitted unless they overlap the objective. This bounds graph-query cost without narrowing the changeset the capable review agent must inspect. Selection scores and omission reasons are recorded in telemetry.

Choose `implement` when code or configuration will change, and `advise` for read-only investigation, diagnosis, explanation, or assessment of existing behavior. Choose `review` only when the actual branch, PR, commit, diff, or working-tree changeset is itself the subject; words such as “changes”, “assess”, or “review” do not by themselves make an objective a changeset review. Choose `merge` only when unmerged conflicts are the subject. Review bases are resolved locally without fetching; configure a current remote-tracking ref such as `origin/dev` instead of a potentially stale local branch.

Repositories may add `.distill/config.toml`:

```toml
[context]
documentation_indexes = ["packages/modules/base/docs/llms.txt"]
default_base = "origin/dev"
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
