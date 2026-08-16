import type { DistillConfig } from "./src/config";

export default {
  output: {
    provider: "codex",
    model: "gpt-5.3-codex-spark",
    codexCommand: "codex",
    timeoutMs: 180_000,
    smallOutputBytes: 2_000,
  },
  context: {
    provider: "codex",
    model: "gpt-5.3-codex-spark",
    codexCommand: "codex",
    reasoningEffort: "low",
    timeoutMs: 300_000,
    childToolOutputTokenLimit: 2_000,
  },
  telemetry: { directory: ".telemetry" },
} satisfies DistillConfig;
