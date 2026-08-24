# Rebuild Distill around repository context and command execution

## Goal

Rebuild Distill as an internal tool that reduces expensive capable-agent usage in two places:

1. Gathering repository context before implementation, advice, review, or merge work.
2. Executing commands whose output may be large, noisy, or empty.

The primary interface is a stdio MCP server exposing exactly two tools:

- `context`
- `run`

Also provide equivalent CLI commands for manual use and testing:

```bash
distill context ...
distill run ...
distill mcp
```

Do not preserve compatibility with the existing stdin pipeline, `translate`, watch mode, interactive-output detection, or other previous interfaces.

## Core design

```text
Capable Codex agent
├── distill.context
│   └── isolated Spark repository agent
│       ├── receives a retrieval-specific objective
│       ├── uses ordinary shell commands in a read-only sandbox
│       ├── returns a structured manifest
│       └── Distill validates and assembles a bounded context packet
│
└── distill.run
    ├── executes the requested command itself
    ├── captures exit code, stdout, stderr, and duration
    ├── returns deterministic output directly when small or empty
    └── uses the configured output provider when compression is needed
```

Do not build a child repository MCP. The Spark context agent should use its normal shell tools inside a read-only Codex sandbox.

## Locked decisions

- The capable-agent interface is one Distill MCP server.
- The MCP server exposes only `context` and `run`.
- Spark receives ordinary read-only shell access.
- Context results are produced from a structured manifest.
- Validate the manifest with Valibot before using it.
- Derive TypeScript types from the Valibot schema.
- Generate the JSON Schema supplied to `codex exec --output-schema` from the same manifest schema.
- Repository-backed task requirements are passed by reference, not copied into the context request.
- Inline evidence is used only when the relevant source text exists solely in the user prompt.
- Long inline evidence may be passed to Spark. Its size is not a concern provided it is not repeated in the returned packet.
- The context packet must digest long tasks rather than reproduce them.
- Read `tool_output_token_limit` from Codex configuration or use a fixed default.
- Keep `distill.config.ts` as Distill’s own trusted configuration source.
- Add optional per-repository `.distill/config.toml`.
- Keep local, Ollama, and external provider machinery for output compression and possible future context support.
- Codex/Spark is the only context-agent provider required now.
- No backwards compatibility.
- No semantic index, embeddings, persistent context sessions, dossier cache, or child MCP.
- No raw-output passthrough on provider failure.
- Runtime telemetry is stored under a gitignored directory in the Distill repository.

## MCP interface

### `context`

Input:

```ts
interface ContextRequest {
  workspaceRoot: string;
  intent: "implement" | "advise" | "review" | "merge";
  objective: string;
  references?: string[];
  inlineEvidence?: string;
  baseRef?: string;
}
```

#### Field meanings

`workspaceRoot`

Absolute path to the target repository.

`intent`

- `implement`: gather context needed to make a correct first implementation pass.
- `advise`: gather context needed to compare options or explain the best approach without editing.
- `review`: gather requirements and repository evidence needed to review a changeset.
- `merge`: gather conflict, branch, and surrounding architectural context needed to resolve a merge.

`objective`

A short retrieval-only description of what context Spark should gather. It must not contain the complete user prompt when the requirements already exist in the repository.

The capable agent should normally keep this below approximately 1,000 characters.

`references`

Repository-resolvable identifiers such as:

- `task-083`
- a file path
- a function or class name
- an error message
- a PR or issue number
- a branch name
- a test name
- a generated file
- a review finding path list

References do not need to be exact paths. The context agent is responsible for resolving them.

`inlineEvidence`

Source material that exists only in the current user prompt, such as a pasted review finding.

Do not put reporting instructions, requested response wording, reviewer orchestration, or implementation process instructions here.

`baseRef`

Optional base branch or commit for review mode. If omitted, use the target repository’s `.distill/config.toml` default when available.

#### MCP tool description

The MCP tool description must explicitly teach the capable agent how to use the tool:

> Use before moderate, broad, architectural, cross-module, review, merge, or unclear repository work. Convert the user request into a retrieval-only objective. Pass repository-backed requirements by task ID, path, symbol, branch, or other reference rather than copying them. Include inlineEvidence only for source text unavailable in the repository. Do not pass reporting instructions, requested response formatting, reviewer orchestration, or other work the parent agent remains responsible for. Skip this tool for narrow tasks that already identify the exact file and local behaviour unless callers, tests, or architectural impact are unclear.

The `context` result should be returned as one compact text content block containing the final packet. Do not return the raw manifest or verbose metadata to the capable agent.

### `run`

Input:

```ts
interface RunStage {
  name: string;
  command: string;
}

type RunRequest = {
  question?: string;
} & (
  | { workspaceRoot: string; cwd?: never }
  | { workspaceRoot?: never; cwd: string }
) & (
  | { command: string; commands?: never }
  | { command?: never; commands: RunStage[] }
);
```

Distill must execute the command itself from `workspaceRoot`.

The capable agent must not run a command and then send its output to Distill. Raw command output must remain outside the capable agent’s context.

If `question` is omitted, use a useful default:

> Report only actionable failures: the shared root cause, affected count, exact paths, line numbers, test names, and error messages. Omit successful stages and successful detail.

#### MCP tool description

> Use to execute builds, tests, linting, type checks, searches, logs, diffs, and other commands whose output may be large, noisy, or empty. Use one `command` for an individual command or dependent pipeline. Prefer named `commands` for multi-stage validation so every stage runs despite earlier failures and receives deterministic status. Omit `question` for ordinary validation; use it only for a short specialized extraction focus, never status requests or parent-task narrative.

The result should be returned as one compact text content block.

## Capable-agent handoff rules

The parent agent already has the user’s complete prompt. Distill should receive only the subset required for repository retrieval.

The context packet must not repeat:

- the full original user prompt;
- reviewer orchestration instructions;
- requested reporting style;
- instructions to explain the final fix;
- instructions to create another agent;
- instructions about how the capable agent should iterate after implementation.

### Backlog task example

User prompt:

```text
Implement task 083. When the first pass is complete, run a Sol/high reviewer and iteratively fix the work until it approves.
```

Context request:

```json
{
  "workspaceRoot": "/home/alex/code/cms",
  "intent": "implement",
  "objective": "Prepare the repository context required to implement task 083 completely.",
  "references": ["task-083"]
}
```

Do not pass the reviewer instruction to Distill.

The Spark agent may read the complete 300–400-line task. The returned packet must instead contain a compact contract, workstreams, file map, tests, risks, and gaps.

### Review-agent example

After implementation, the separate review agent should call Distill itself:

```json
{
  "workspaceRoot": "/home/alex/code/cms",
  "intent": "review",
  "objective": "Prepare evidence for reviewing the current branch implementation against the complete task-083 contract.",
  "references": ["task-083"],
  "baseRef": "dev"
}
```

Do not make the implementation agent gather a packet and paste it into the review agent’s prompt. Each capable agent should obtain its own packet directly.

### Narrow function example

User prompt:

```text
In path/to/file.ts, function createThing should accept fewer arguments. Implement that.
```

Distill can be skipped when the task is clearly local.

Use Distill when impact is unclear:

```json
{
  "workspaceRoot": "/repo",
  "intent": "implement",
  "objective": "Identify the repository-consistent way to reduce createThing's arguments, including all callers and affected tests.",
  "references": ["path/to/file.ts", "createThing"]
}
```

For an options request, use `intent: "advise"`.

### Pasted review finding example

User prompt contains a full review issue that is not otherwise stored in the repository.

Context request:

```json
{
  "workspaceRoot": "/home/alex/code/cms",
  "intent": "implement",
  "objective": "Prepare implementation context for fixing the accepted stale cleanup-worker lease race and adding the required integration coverage.",
  "references": [
    "task-083",
    "packages/modules/core/server/src/utils/cleanup/worker.ts",
    "packages/modules/core/server/src/utils/content/mediaMutation.ts"
  ],
  "inlineEvidence": "ISSUE:\n[P1] A stale cleanup worker can delete media after the content transaction has claimed it...\n"
}
```

Passing inline evidence once is acceptable. Distill must summarize it into requirements and risks rather than reproducing it verbatim in the packet.

## Context-agent execution

Run an isolated Codex child using the configured context model, initially `gpt-5.3-codex-spark`.

The child should use approximately this execution profile:

```bash
codex exec \
  --model gpt-5.3-codex-spark \
  --ephemeral \
  --ignore-user-config \
  --ignore-rules \
  --sandbox read-only \
  --json \
  --output-schema <manifest-schema-path> \
  --output-last-message <manifest-output-path> \
  --cd <workspace-root> \
  -c 'approval_policy="never"' \
  -c 'model_reasoning_effort="medium"' \
  -c 'agents.enabled=false' \
  -c 'web_search="disabled"' \
  -c 'project_doc_max_bytes=0' \
  -c 'tool_output_token_limit=8000' \
  -c 'model_instructions_file=<context-instructions-path>' \
  -
```

Exact CLI argument ordering may follow current Codex requirements.

Requirements:

- Shell access remains enabled.
- Sandbox is read-only.
- Web search is disabled.
- Subagents are disabled.
- Ordinary user configuration and project-rule auto-injection are disabled.
- The child must read applicable repository instructions itself through shell access.
- Use `--json` so usage and child activity can be captured for telemetry.
- Supply a strict output schema.
- Treat the child’s final output as untrusted until validated by Valibot.

## Context-agent instructions

Create a dedicated context-agent instruction file with this behaviour:

```text
You are a read-only repository context agent for a stronger coding agent.

Your job is to gather the smallest complete set of repository evidence needed
for the parent agent to begin the requested implementation, advice, review, or
merge work correctly.

Do not implement, edit files, run builds, run tests, format files, commit,
push, or start subagents.

Use shell commands only for read-only repository inspection.

Resolve supplied references first. A reference may be a task ID, partial path,
symbol, branch, error, test name, or review identifier.

Read applicable AGENTS.md files and other repository instructions.

Read .distill/config.toml when present. Consult each configured documentation
index when it may apply.

For long task files, digest their requirements. Do not copy the task into the
manifest. Extract the contract, acceptance criteria, exclusions, ordered
workstreams, risks, and required validation.

Identify:
- applicable repository rules;
- architectural requirements;
- acceptance criteria;
- out-of-scope constraints;
- likely edit owners;
- direct callers of signatures likely to change;
- behaviour-owning tests;
- generated-file ownership;
- relevant existing examples;
- validation commands;
- explicit unresolved gaps.

For implement intent, focus on what is required for a correct first edit.

For advise intent, gather the contracts and alternatives needed to compare
approaches without assuming implementation.

For review intent, inspect the base-to-head changeset and compare it with the
referenced requirements and nearby repository contracts.

For merge intent, inspect unmerged files first. Compare base, ours, and theirs
where useful, then inspect only the surrounding contracts needed to resolve
the conflict correctly.

Stop once the manifest contains sufficient evidence. Return only the required
structured manifest.
```

## Repository configuration

Support optional configuration at:

```text
<workspaceRoot>/.distill/config.toml
```

Initial supported shape:

```toml
[context]
documentation_indexes = [
  "packages/modules/base/docs/llms.txt"
]

default_base = "dev"
```

Only implement these initial fields:

- `context.documentation_indexes`
- `context.default_base`

Do not turn this into a large repository rule language.

Spark should still discover applicable `AGENTS.md` files without requiring them to be listed here.

The existing trusted `distill.config.ts` remains Distill’s provider and runtime configuration source. It is not replaced with TOML.

## Manifest

Define a Valibot schema equivalent to:

```ts
interface ContextManifest {
  summary: string;

  notes: Array<{
    kind:
      "rule" | "requirement" | "acceptance" | "out_of_scope" | "workstream" | "finding" | "risk";
    text: string;
    source?: {
      path: string;
      startLine?: number;
      endLine?: number;
    };
    priority: 1 | 2 | 3;
  }>;

  files: Array<{
    path: string;
    role: "edit" | "caller" | "test" | "documentation" | "generated" | "changed" | "conflict";
    reason: string;
    ranges?: Array<{
      startLine: number;
      endLine: number;
    }>;
    priority: 1 | 2 | 3;
    includeExcerpt: boolean;
  }>;

  validation: string[];
  gaps: string[];
}
```

`priority: 1` is highest priority.

Distill must:

1. Parse the child result.
2. Validate it with Valibot.
3. Reject or omit paths outside `workspaceRoot`.
4. Verify referenced files exist.
5. Verify line numbers are positive and valid for the file.
6. Merge overlapping or adjacent ranges for the same file.
7. Read exact excerpts itself.
8. Add stable line numbers.
9. Build the final packet within the parent output budget.
10. Record invalid manifest entries in telemetry.
11. Convert important invalid or missing evidence into a visible `GAPS` entry rather than silently ignoring it.

Do not trust source text reproduced by Spark. Spark identifies evidence; Distill reads exact source from disk.

## Context packet

Use a compact format similar to:

```text
CONTEXT v1 id=ctx_123 head=abc123 dirty=yes

TASK
Implement the durable cleanup lease requirements from task-083.

CONTRACT
- Cleanup must conditionally lease a pending record before inspecting targets.
- A content claim that wins first must cause a stale worker lease to fail.
- Cleanup must remain bounded and retryable.
- Do not add a second media-specific mutation path.

WORKSTREAMS
1. Extend cleanup-record state and lease fields.
2. Add conditional lease acquisition.
3. Route worker processing through the lease result.
4. Add the claim-versus-cleanup race integration test.

RISKS
- A worker operating from a stale due-index result can currently delete claimed media.

FILES
EDIT packages/.../tables.ts — cleanup entity schema
EDIT packages/.../cleanup/worker.ts — lease acquisition and worker flow
CALLER packages/.../cleanup/media.ts — deletion path
TEST packages/.../mediaMutation.int.test.ts — required race coverage

EXCERPTS
packages/.../cleanup/worker.ts:106-135
106 | ...
107 | ...

VALIDATE
pnpm run build
pnpm test "packages/.../mediaMutation.int.test.ts"

GAPS
none
```

Always include these sections when applicable:

- `TASK`
- `CONTRACT`
- `WORKSTREAMS`
- `RISKS`
- `FILES`
- `EXCERPTS`
- `VALIDATE`
- `GAPS`

Omit empty optional sections other than `GAPS`.

### Large-task priority

When the task is large, allocate packet space in this order:

1. Compact task contract.
2. Gaps and serious risks.
3. Ordered workstreams.
4. File, caller, and test map.
5. Exact excerpts.

A large task may contain few or no excerpts. Do not drop critical requirements or exclusions merely to include source code that the capable agent can read later.

The parent agent may perform one targeted follow-up read after receiving the packet. The packet should prevent broad exploratory reading.

### Avoid prompt repetition

The packet must not reproduce:

- the full task file;
- long pasted review findings;
- the original capable-agent prompt;
- reviewer orchestration;
- requested final-answer wording.

Summarize these into the task contract, risks, workstreams, and gaps.

## Parent output budget

Resolve the capable agent’s tool-output limit using only:

1. `$CODEX_HOME/config.toml`, or `~/.codex/config.toml` when `CODEX_HOME` is unset.
2. A Distill default of `2500` tokens when the file or setting is absent or invalid.

Read only the top-level:

```toml
tool_output_token_limit = 2000
```

Do not implement profile resolution, project-level Codex configuration, or command-line override discovery.

Calculate:

```ts
const toolOutputTokenLimit = configuredValue ?? 2500;
const resultTokenBudget = Math.floor(toolOutputTokenLimit * 0.8);
const resultByteBudget = resultTokenBudget * 4;
```

Examples:

```text
Configured 2000 → target 1600 tokens / 6400 bytes
Default 2500    → target 2000 tokens / 8000 bytes
```

Use the same result budget for both MCP tools.

Packet assembly must be priority-based. Do not render a large packet and then blindly truncate its middle.

A final hard byte cap may exist as a last safety check, but normal output should fit through deliberate section and excerpt selection.

## `run` behaviour

Distill executes the requested command from `workspaceRoot` and captures:

- exit code;
- stdout;
- stderr;
- duration;
- termination error when applicable.

For named `commands`, execute stages sequentially in order and continue after every failure. Capture each stage independently and return deterministic aggregate and per-stage status. Compress their combined output in at most one provider call. The single `command` form retains normal shell semantics for genuinely dependent pipelines.

Unix execution support is required. Use the current platform shell without building a large cross-platform command abstraction.

### Empty output

Successful command:

```text
PASS exit=0
```

Failed command:

```text
FAIL exit=1
```

This must solve silent successful commands such as linting or formatting checks without requiring the capable agent to rerun them.

### Small output

Default threshold:

```ts
const SMALL_OUTPUT_BYTES = 2000;
```

When combined stdout and stderr are at or below the threshold, do not invoke a model.

Return exact output with deterministic status:

```text
PASS exit=0
<raw output>
```

or:

```text
FAIL exit=1
<raw output>
```

### Large output

When output exceeds the threshold, invoke the configured output provider.

The model receives:

- command;
- question;
- exit code;
- stdout;
- stderr.

Distill, not the model, adds the final deterministic status header:

```text
FAIL exit=1
<compressed actionable output>
```

The model must not be trusted to infer or report the exit code. Its result is a compact plain-text line protocol without Markdown, emoji, conversational framing, or duplicated status. Ordinary summaries target 2,000 bytes and have an 8,000-byte hard maximum for independent actionable failures. Codex output compression uses low reasoning effort.

### Provider failure

Do not return the complete raw output.

Return a bounded deterministic extract containing:

- command status;
- exit code;
- `provider-error`;
- a useful head/tail sample of the raw output within the result budget.

Example:

```text
FAIL exit=1 provider-error
[output head]
...
[output tail]
```

There is no passthrough option.

## Output provider architecture

Retain the existing provider machinery for output compression:

- Codex
- local model server
- Ollama
- external OpenAI-compatible endpoint

Restructure it behind an output-specific interface:

```ts
interface OutputProvider {
  summarize(request: OutputSummaryRequest): Promise<string>;
}
```

Add a separate context-provider interface:

```ts
interface ContextAgentProvider {
  gather(request: ContextAgentRequest): Promise<ContextManifest>;
}
```

Initially, only the Codex provider needs to implement `ContextAgentProvider`.

Do not force existing local providers to support context mode now. Preserve the architecture so an agentic local model can support it later.

## Distill configuration

Redesign `distill.config.ts` without compatibility requirements.

A suitable shape is:

```ts
export default {
  output: {
    provider: "codex",
    model: "gpt-5.3-codex-spark",
    codexCommand: "codex",
    timeoutMs: 180_000,
    smallOutputBytes: 2000,

    // Existing local/Ollama/external settings may remain available here.
  },

  context: {
    provider: "codex",
    model: "gpt-5.3-codex-spark",
    codexCommand: "codex",
    reasoningEffort: "medium",
    timeoutMs: 180_000,
    childToolOutputTokenLimit: 8000,
  },

  telemetry: {
    directory: ".telemetry",
  },
} satisfies DistillConfig;
```

The exact nesting may be improved if another clean discriminated structure is clearer.

Do not preserve old configuration field compatibility.

## CLI

Implement:

```bash
distill mcp
```

Starts the stdio MCP server.

```bash
distill run -- pnpm lint
```

Executes the command through the same implementation used by the MCP `run` tool.

```bash
distill context \
  --intent implement \
  --reference task-083 \
  "Prepare the repository context required to implement task 083 completely."
```

The CLI context command should support:

- `--intent`
- repeated `--reference`
- `--base-ref`
- an optional inline-evidence file if simple to support

The MCP interface is authoritative. The CLI exists for manual testing and debugging and should reuse the same request handlers.

Remove support for:

```bash
command | distill "question"
distill translate ...
```

Do not retain aliases or deprecation warnings.

## MCP server requirements

Use stdio transport.

The MCP server must emit no non-protocol content to stdout.

Progress and diagnostics may go to stderr only.

The npm launcher and native binary wrapper must not show progress UI or inject output when running `distill mcp`.

A Codex MCP configuration should work like:

```toml
[mcp_servers.distill]
command = "distill"
args = ["mcp"]
cwd = "/home/alex/code/distill"
required = true
enabled_tools = ["context", "run"]
tool_timeout_sec = 300
```

Update the README with:

- MCP configuration;
- tool descriptions;
- handoff rules;
- backlog-task example;
- review-agent example;
- pasted-review-finding example;
- `.distill/config.toml` example;
- CLI examples.

## Telemetry

Create a gitignored directory in the Distill repository:

```text
.telemetry/
```

Write one JSON file per invocation.

Context telemetry should include:

```ts
{
  id: string;
  timestamp: string;
  mode: 'context';
  workspaceRoot: string;
  intent: ContextRequest['intent'];
  objective: string;
  references: string[];
  inlineEvidenceBytes: number;
  inlineEvidenceHash?: string;
  baseRef?: string;
  provider: string;
  model: string;
  durationMs: number;
  usage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
  };
  childToolCalls?: number;
  resolvedToolOutputTokenLimit: number;
  resultTokenBudget: number;
  resultByteBudget: number;
  manifest?: ContextManifest;
  manifestValidationErrors?: unknown[];
  packetBytes?: number;
  packet?: string;
  failure?: string;
}
```

Do not store the full `inlineEvidence` value.

Run telemetry should include:

```ts
{
  id: string;
  timestamp: string;
  mode: 'run';
  workspaceRoot: string;
  command?: string;
  commands?: RunStage[];
  question?: string;
  provider?: string;
  model?: string;
  durationMs: number;
  exitCode: number | null;
  stages?: Array<{
    name: string;
    command: string;
    exitCode: number | null;
    durationMs: number;
    stdoutBytes: number;
    stderrBytes: number;
    terminationError?: string;
  }>;
  stdoutBytes: number;
  stderrBytes: number;
  resultBytes: number;
  distilled: boolean;
  fallbackReason?: string;
  usage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
  };
}
```

Do not store complete raw command output by default.

Store the context manifest and final packet because they are needed to diagnose poor retrieval or packet packing.

Add `.telemetry/` to `.gitignore`.

Runtime telemetry remains uncommitted. Creating a future committed eval suite from selected runs is out of scope.

## Remove obsolete implementation

Delete or replace the existing machinery for:

- stdin pipeline processing;
- `translate`;
- watch mode;
- interactive prompt detection;
- `DistillSession`;
- stream redraw handling;
- raw-output passthrough on provider failure;
- old command parsing;
- old configuration compatibility.

Retain:

- native package/build machinery;
- platform packages;
- local model server support;
- Ollama/external output-provider support;
- Codex execution support;
- existing useful text-normalisation helpers where still applicable.

The existing pure-transform Codex execution profile may remain conceptually separate from the new repository-context profile.

Do not turn one request type into a large set of flags. Use distinct implementations for:

```ts
type CodexRequest = OutputTransformRequest | RepositoryContextRequest;
```

## Suggested implementation areas

The current cleaned repository should be restructured as needed. Likely areas include:

```text
src/cli.ts
src/config.ts
src/codex-cli.ts
src/llm.ts
src/prompt.ts
src/user-config.ts
src/local-server.ts
packages/cli/bin/distill.js
README.md
.gitignore
```

Likely new files:

```text
src/mcp.ts
src/context.ts
src/context-agent.ts
src/context-manifest.ts
src/context-packet.ts
src/codex-config.ts
src/repo-config.ts
src/run-command.ts
src/telemetry.ts
```

Likely obsolete file:

```text
src/stream-distiller.ts
```

Names may be adjusted when a cleaner structure is apparent.

Add Valibot and the MCP SDK dependencies required by the implementation.

## Testing

Use fake providers and fake Codex executables for deterministic tests. Normal tests must not consume live model usage.

### Configuration tests

Cover:

- redesigned `distill.config.ts` parsing;
- output-provider configuration;
- context-provider configuration;
- missing configuration defaults;
- invalid configuration errors;
- `.distill/config.toml` parsing;
- configured documentation indexes;
- configured default base;
- Codex `tool_output_token_limit`;
- missing Codex config;
- invalid Codex limit;
- `CODEX_HOME`;
- fallback to `~/.codex/config.toml`;
- fixed default of 2500.

### Context-agent tests

Cover:

- correct `codex exec` working directory;
- read-only sandbox;
- shell remains enabled;
- web disabled;
- subagents disabled;
- user config and rules ignored;
- child tool-output limit set to 8000 by default;
- configured reasoning effort;
- output schema supplied;
- JSONL usage captured;
- manifest output read;
- timeout and non-zero child failures.

### Manifest tests

Cover:

- valid manifest;
- invalid manifest rejection;
- derived TypeScript type;
- generated JSON schema;
- path traversal;
- path outside repository;
- missing files;
- invalid line ranges;
- ranges beyond end of file;
- overlapping-range merging;
- invalid entries becoming gaps;
- exact source read from disk instead of model-provided text.

### Packet tests

Cover:

- packet fits configured byte budget;
- configured 2000-token limit produces a target of 6400 bytes;
- default 2500-token limit produces a target of 8000 bytes;
- mandatory contract and gaps are retained before excerpts;
- lower-priority excerpts are omitted before requirements;
- large task manifest produces a compact contract rather than task reproduction;
- source excerpts include line numbers;
- packet does not include full inline evidence;
- final hard cap preserves valid UTF-8;
- empty gaps render as `GAPS\nnone`.

### Run tests

Cover:

- empty successful command;
- empty failed command;
- small successful output;
- small failed output;
- large output invokes the provider;
- exit code is added deterministically;
- default question;
- explicit question;
- stdout and stderr capture;
- provider failure returns bounded head/tail;
- provider failure never returns complete large output;
- command executes from `workspaceRoot`;
- command duration recorded;
- telemetry recorded.

### MCP tests

Cover:

- stdio server exposes only `context` and `run`;
- tool schemas match the required request types;
- tool descriptions contain the handoff guidance;
- context returns one text content block;
- run returns one text content block;
- MCP mode emits no non-protocol stdout;
- native/npm launcher does not show progress in MCP mode.

### CLI tests

Cover:

- `distill mcp`;
- `distill context`;
- repeated references;
- context intent;
- base reference;
- `distill run ... -- command`;
- removed stdin pipeline behaviour;
- removed `translate`;
- unknown commands and flags.

### Telemetry tests

Cover:

- one file per invocation;
- context manifest and packet stored;
- inline evidence omitted and hashed;
- raw command output omitted;
- usage stored when available;
- telemetry failures do not fail the primary command.

## Acceptance criteria

- Codex can configure Distill as a required stdio MCP server.
- The server exposes only `context` and `run`.
- A capable agent can reference a 300–400-line backlog task by task ID without copying it into the tool call.
- Spark reads and digests the complete task.
- The returned packet contains a compact contract, ordered workstreams, edit/caller/test map, validation, risks, and gaps.
- The returned packet does not reproduce the complete task.
- A separate review agent can call Distill directly for review context without receiving a packet copied through the implementation agent.
- Pasted review evidence can be passed once through `inlineEvidence`.
- Long inline evidence is summarized and not returned verbatim.
- Spark uses normal shell tools under a read-only sandbox.
- No child MCP exists.
- Spark returns a structured manifest.
- The manifest is validated with Valibot.
- Exact excerpts are read by Distill from disk.
- The packet respects 80% of the resolved Codex tool-output limit.
- The only parent-limit sources are top-level Codex configuration or the 2500-token default.
- `run` executes commands itself so raw output never enters the capable agent’s context.
- Silent successful and failed commands always return an explicit result.
- Small output is returned directly without model usage.
- Large output is compressed by the configured output provider.
- Provider failure returns a bounded extract rather than the complete raw output.
- Local, Ollama, and external output-provider machinery remains available.
- Context mode initially uses Codex/Spark only.
- Old stdin, translate, watch, and interactive interfaces are removed.
- No backwards compatibility code remains.
- Runtime telemetry is written under a gitignored `.telemetry/` directory.
- README documentation explains setup, handoff behaviour, repository configuration, and representative workflows.
- Existing native build and package workflows continue to work.

## Out of scope

- Child repository MCP.
- Custom repository search tools.
- Semantic indexing.
- Embeddings.
- Persistent or resumable Spark context sessions.
- Context dossier cache or packet pagination.
- Automatic access to the parent Codex conversation log.
- Eliminating the single unavoidable duplicate when long evidence exists only in the user prompt.
- Automatic reviewer creation or iteration.
- Implementation work by the context child.
- Builds or tests run by the context child.
- Support for Codex profiles or command-line configuration overrides when resolving the parent tool-output limit.
- First-class local-model context agents.
- Raw-output passthrough options.
- Backwards compatibility.
- Package renaming or release-process redesign unrelated to this task.

## Final validation

Run the complete repository validation:

```bash
pnpm run verify
```

Also perform a manual MCP smoke test with a fake or controlled repository:

1. Start `distill mcp`.
2. Call `context` for a repository-backed task reference.
3. Confirm the packet fits the configured tool-output limit.
4. Confirm the task text is digested rather than repeated.
5. Call `run` with a silent successful command.
6. Confirm it returns `PASS exit=0`.
7. Call `run` with a failing command producing large output.
8. Confirm the result is bounded and contains the deterministic exit status.
9. Confirm telemetry files are written without raw command output or full inline evidence.
