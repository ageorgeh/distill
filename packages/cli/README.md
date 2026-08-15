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
  provider: "codex",
  codexModel: "gpt-5.3-codex-spark",
  timeoutMs: 180_000,
};
```

Pipe output into `distill` with a question:

```bash
bun test 2>&1 | distill "Did the tests pass? Return PASS or FAIL."
```

Use `--debug` for fallback diagnostics, or `--help` and `--version` for the
action reference.
