# distill

`distill` compresses command output before it reaches another model, preserving
the useful signal while reducing token use.

## Install

```bash
npm i -g @samuelfaj/distill
```

For a local checkout:

```bash
pnpm install
pnpm run build
cd packages/cli
pnpm link . --global
cd ../..
distill --version
```

## Configure

Configuration lives in `distill.config.ts` in the directory where `distill` is
run. There is no setup flow and no environment-variable or
configuration-flag override path.

```ts
import type { PersistedConfig } from "./src/config";

export default {
  provider: "codex",
  codexModel: "gpt-5.3-codex-spark",
  codexCommand: "codex",
  timeoutMs: 180_000,
} satisfies PersistedConfig;
```

The supported providers are `local`, `ollama`, `external`, and `codex`. Keep
provider settings, model names, endpoints, credentials, and timeouts in this
file.

## Use

```bash
bun test 2>&1 | distill "Did the tests pass? Return PASS or FAIL, followed by failing test names."
git diff 2>&1 | distill "List changed files and the reason for each change."
terraform plan 2>&1 | distill "Return SAFE, REVIEW, or UNSAFE and list exact risky changes."
```

Use `--debug` when diagnosing a fallback; diagnostics are written to `stderr`.
`--help`, `--version`, and `translate` are the other action interfaces.

```bash
printf 'PASS auth.test.ts\nFAIL queue.test.ts\n' \
  | distill --debug "Did tests pass? Return only PASS or FAIL followed by failing test names."

distill translate "PASS tests pass" en-US
```

When a provider request fails or the output looks unsuitable for compression,
`distill` returns the original command output.

## Making changes

After making changes, run `pnpm run verify`. This is the regular validation
process and runs TypeScript checking, the test suite, the build, and the release
check in order.
