# distill

Agent command outputs are one of the biggest sources of token waste.

Logs, test results, stack traces… thousands of tokens sent to an LLM just to answer a simple question.

**🔥 `distill` compresses command outputs into only what the LLM actually needs.**

Save **up to 99% of tokens** without losing the signal.

## How to use

Install:

```bash
npm i -g @samuelfaj/distill
```

Local install from this repo (no publish):

```bash
# from repo root
pnpm install
pnpm run build
cd packages/cli
pnpm link --global
cd ../..
pnpm list -g @samuelfaj/distill
distill --version


```

Notes:

- `pnpm run build` compiles and syncs the native binary for your current platform into `packages/distill-*/bin`.
- `pnpm link --global` from `packages/cli` gives you the real global-style `distill` command from local source.
- `pnpm list -g @samuelfaj/distill` should show `@samuelfaj/distill@link:.../packages/cli`.
- If `distill` is not found after linking, ensure your `PNPM_HOME` is on `PATH`.

Update after new local changes:

```bash
pnpm run build
```

Remove global local link:

```bash
pnpm unlink --global @samuelfaj/distill
```

Run onboarding:

```bash
distill
```

After onboarding you can use `/distill` in Claude/Codex to make the agent keep talking in distill language for the whole thread.

It should not return your prompt rewritten. It should adopt the language structure and keep using it.

## Our Model

Distill uses it's own **Expert Language Model**

https://huggingface.co/samuelfaj/distill-1.7B-MLX

**Only: 1.7B - 4bit**

`/distill` uses English Military English + AR-0/AR-1 plus shared DSL memory with tiny keys:

- fixed prefixes: `S` state, `C` cause/context, `D` action/decision, `R` risk, `O` outcome, `N` no-go, `P` proof/pass
- aliases: `A` auth, `B` backend, `F` frontend, `E` E2E, `V` env, `X` deps, `U` UI, `DB` database, `CFG` config, `DOC` docs, `PERM` permissions
- macros: `1` test first, `2` run tests, `3` report summary/files/tests/status, `4` review, `5` fix, `6` validate, `7` commit/push, `8` PR, `9` release, `0` raw output
- defaults: `N1` no frontend, `N2` no backend, `N3` no UI, `N4` no broad refactor, `N5` preserve user changes, `N6` TUI/interactive
- learned terms start as candidates, promote after repeated use, and expire when unused

Response shape favors semantic atoms:

```text
Dict: S=state C=context D=action R=risk O=outcome N=no-go P=proof
S glab auth fail gitlab.com
D inspect remotes + MR meta
R merge/update may block w/o token
```

It can also set inline variables for repeated nouns. The model chooses them dynamically from terms that repeat or are likely to repeat; there is no fixed variable list. Inline variables stay thread-local unless `distill dsl learn-thread --stdin` sees the explicit variable more than 5 times in the transcript. Learned entries are removed when absent from the next learned thread.

```text
S cache=#c1 warmed model=#m1
D inspect #c1 hit rate
D compare #m1 latency
```

Manage DSL memory:

```bash
distill dsl show
distill dsl show --candidates
distill dsl learn --dry-run "Dict+: A1=authentication fix"
distill dsl learn-thread --stdin --dry-run < transcript.txt
distill dsl promote --dry-run
distill dsl add alias A1 "authentication bug fix" --scope project
distill dsl add macro 1 "add failing regression test first" --scope global
distill dsl pin A1 --scope project
distill dsl prune --dry-run
```

Normal `distill` runs load only compact active DSL memory into the prompt. If the model emits reusable `Dict+` entries, `distill` learns them as project candidates using the shortest available key, promotes them after repeated use, and keeps stack/global promotion gated by `distill dsl promote`.

At thread end, export or pipe the transcript through `distill dsl learn-thread --stdin`. It extracts repeated workflow language, asks the configured reviewer model for strict JSON, rejects sensitive/noisy terms, and saves approved entries as candidates.

You can also pipe command output into `distill`:

```bash
bun test 2>&1 | distill "Did tests pass? Return PASS or FAIL, followed by failing test names if any."
git diff | distill "What changed? Return only files changed and one-line summary for each."
terraform plan 2>&1 | distill "Is this safe? Return SAFE, REVIEW, or UNSAFE, followed by risky changes."
```

Debug raw fallback reasons:

```bash
cmd 2>&1 | distill --debug "Did tests pass? Return PASS or FAIL."
DISTILL_DEBUG=true cmd 2>&1 | distill "Did tests pass? Return PASS or FAIL."
```

Debug logs go to `stderr` with prefix `distill: debug:` and reason keys like:
`fallback=batch_bad_distillation`, `fallback=batch_error`,
`fallback=interactive_prompt`, `fallback=watch_bad_distillation`, `fallback=watch_error`.

**Recommended LLM: qwen3.5-4b**

Safe recommendation: machine should have 8 GB+ RAM; 16 GB+ is comfortable.

## Example

```sh
rg -n "terminal|PERMISSION|permission|Permissions|Plan|full access|default" desktop --glob '!**/node_modules/**' | distill "find where terminal and permission UI are implemented in chat screen"
```

- **Before:** [7648 tokens 30592 characters 10218 words](./examples/1/BEFORE.md)
- **After:** [99 tokens 396 characters 57 words](./examples/1/AFTER.md)
- **🔥 Saved ~98.7% tokens**

## Distill Language

We also teach your LLM to talk and think a more efficient way.

![Distill Language](https://github.com/samuelfaj/distill/blob/main/examples/distill-language.png?raw=true)
