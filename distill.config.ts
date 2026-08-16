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
    reasoningEffort: "medium",
    timeoutMs: 240_000,
    childToolOutputTokenLimit: 8_000,
  },
  telemetry: { directory: ".telemetry" },
} satisfies DistillConfig;
