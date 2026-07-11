import type { PersistedConfig } from "./src/config";

export default {
  // provider: "ollama",
  // host: "http://127.0.0.1:11434/v1",
  // model: "qwen3.5:4b",
  provider: "codex",
  timeoutMs: 180_000,
  datasetEnabled: false,
} satisfies PersistedConfig;
