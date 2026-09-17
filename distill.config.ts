import type { DistillConfig } from "./src/config";

export default {
  output: {
    provider: "codex",
    model: "gpt-5.6-luna",
    codexCommand: "codex",
    timeoutMs: 180_000,
    smallOutputBytes: 2_000,
  },
  context: {
    provider: "codex",
    model: "gpt-5.6-luna",
    codexCommand: "codex",
    reasoningEffort: "low",
    timeoutMs: 90_000,
  },
  telemetry: { directory: ".telemetry" },
} satisfies DistillConfig;
