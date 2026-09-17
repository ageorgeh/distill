# @samuelfaj/distill

Install the CLI globally:

```bash
npm i -g @samuelfaj/distill
```

Create `distill.config.ts` in the directory where you run the command. All
provider and runtime settings are read from that file; the CLI has no setup
flow and does not accept configuration overrides through environment variables
or flags.

```ts
export default {
  output: { provider: "codex", model: "gpt-5.6-luna", timeoutMs: 180_000 },
  context: { model: "gpt-5.6-luna", reasoningEffort: "low" },
};
```

Run a command and optionally ask a question about its output:

```bash
distill run "Summarize test failures" -- bun test
```

For repository context, use `distill context gather --intent implement "Locate the implementation."`.
Use `--help` and `--version` for the command reference.
