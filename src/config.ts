import cliPackage from "../packages/cli/package.json";

export const DISTILL_VERSION = cliPackage.version;
export const DEFAULT_CODEX_MODEL = "gpt-5.3-codex-spark";
export const DEFAULT_CODEX_COMMAND = "codex";
export const DEFAULT_HOST = "http://127.0.0.1:11434/v1";
export const DEFAULT_TIMEOUT_MS = 180_000;
export const DEFAULT_CONTEXT_TIMEOUT_MS = 90_000;
export const DEFAULT_SMALL_OUTPUT_BYTES = 2_000;
export const DEFAULT_PARENT_TOOL_OUTPUT_LIMIT = 2_500;
export const DEFAULT_GORTEX_COMMAND = "gortex";
export const DEFAULT_GORTEX_TIMEOUT_MS = 60_000;
export const DEFAULT_GORTEX_MAX_SYMBOLS = 100;
export const DEFAULT_GORTEX_MAX_OUTPUT_BYTES = 200_000;
export const DEFAULT_LOCAL_BACKEND = "auto";
export const DEFAULT_LOCAL_CONCURRENCY = 5;
export const DEFAULT_LOCAL_HOST = "127.0.0.1";
export const DEFAULT_LOCAL_PORT = 8009;
export const DISTILL_MLX_MODEL = "samuelfaj/distill-1.7B-4bit-MLX";
export const DISTILL_LLAMA_MODEL = "distill-local";

export type Provider = "local" | "ollama" | "external" | "codex";
export type LocalBackend = "auto" | "mlx" | "llamacpp";
export type ContextIntent = "implement" | "advise" | "merge-review" | "merge";

export interface OutputConfig {
  provider: Provider;
  model: string;
  codexCommand: string;
  timeoutMs: number;
  smallOutputBytes: number;
  host: string;
  apiKey: string;
  localBackend: LocalBackend;
  localConcurrency: number;
  localHost: string;
  localPort: number;
}

/** Useful compatibility name for the local-server module. */
export type RuntimeConfig = OutputConfig;

export interface ContextConfig {
  provider: "codex";
  model: string;
  codexCommand: string;
  reasoningEffort: string;
  timeoutMs: number;
  gortexCommand: string;
  gortexTimeoutMs: number;
  gortexMaxSymbols: number;
  gortexMaxOutputBytes: number;
}

export interface DistillConfig {
  output?: Partial<OutputConfig>;
  context?: Partial<ContextConfig>;
  telemetry?: { directory?: string };
}

export interface ResolvedConfig {
  output: OutputConfig;
  context: ContextConfig;
  telemetry: { directory: string };
}

export interface ContextGatherRequest {
  action: "gather";
  workspaceRoot: string;
  intent: ContextIntent;
  objective: string;
  references?: string[];
  inlineEvidence?: string;
  baseRef?: string;
}

export type ContextRequest = ContextGatherRequest;

export interface RunStage {
  name: string;
  command: string;
}

interface RunRequestBase {
  question?: string;
}

export type RunRequest = RunRequestBase & (
  | { workspaceRoot: string; cwd?: never }
  | { workspaceRoot?: never; cwd: string }
) & (
  | { command: string; commands?: never }
  | { command?: never; commands: RunStage[] }
);

export type Command =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "mcp" }
  | { kind: "run"; request: RunRequest }
  | { kind: "context"; request: ContextRequest; inlineEvidenceFile?: string };

export class UsageError extends Error {
  readonly exitCode = 2;
  constructor(message: string) { super(message); this.name = "UsageError"; }
}

function positive(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new UsageError(`${label} must be a positive number.`);
  return Math.floor(number);
}

function provider(value: unknown, fallback: Provider): Provider {
  if (value === undefined) return fallback;
  if (value === "local" || value === "ollama" || value === "external" || value === "codex") return value;
  throw new UsageError("output.provider must be local, ollama, external, or codex.");
}

function backend(value: unknown): LocalBackend {
  if (value === undefined) return DEFAULT_LOCAL_BACKEND;
  if (value === "auto" || value === "mlx" || value === "llamacpp") return value;
  throw new UsageError("output.localBackend must be auto, mlx, or llamacpp.");
}

function text(value: unknown, fallback: string, label: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim()) throw new UsageError(`${label} must be a non-empty string.`);
  return value.trim();
}

function localModel(selected: LocalBackend): string {
  const resolved = selected === "auto" ? (process.platform === "darwin" && process.arch === "arm64" ? "mlx" : "llamacpp") : selected;
  return resolved === "mlx" ? DISTILL_MLX_MODEL : DISTILL_LLAMA_MODEL;
}

export function resolveConfig(config: DistillConfig = {}): ResolvedConfig {
  const rawOutput = config.output ?? {};
  const outputProvider = provider(rawOutput.provider, "codex");
  const localBackend = backend(rawOutput.localBackend);
  const localHost = text(rawOutput.localHost, DEFAULT_LOCAL_HOST, "output.localHost");
  const localPort = positive(rawOutput.localPort, DEFAULT_LOCAL_PORT, "output.localPort");
  if (localPort > 65_535) throw new UsageError("output.localPort must be between 1 and 65535.");
  const host = text(rawOutput.host, DEFAULT_HOST, "output.host").replace(/\/$/, "");
  const output: OutputConfig = {
    provider: outputProvider,
    model: text(rawOutput.model, outputProvider === "local" ? localModel(localBackend) : DEFAULT_CODEX_MODEL, "output.model"),
    codexCommand: text(rawOutput.codexCommand, DEFAULT_CODEX_COMMAND, "output.codexCommand"),
    timeoutMs: positive(rawOutput.timeoutMs, DEFAULT_TIMEOUT_MS, "output.timeoutMs"),
    smallOutputBytes: positive(rawOutput.smallOutputBytes, DEFAULT_SMALL_OUTPUT_BYTES, "output.smallOutputBytes"),
    host: outputProvider === "local" ? `http://${localHost}:${localPort}/v1` : host,
    apiKey: typeof rawOutput.apiKey === "string" ? rawOutput.apiKey : "",
    localBackend,
    localConcurrency: positive(rawOutput.localConcurrency, DEFAULT_LOCAL_CONCURRENCY, "output.localConcurrency"),
    localHost,
    localPort,
  };
  const rawContext = config.context ?? {};
  if (rawContext.provider !== undefined && rawContext.provider !== "codex") throw new UsageError("context.provider must be codex.");
  const contextTimeoutMs = positive(rawContext.timeoutMs, DEFAULT_CONTEXT_TIMEOUT_MS, "context.timeoutMs");
  const context: ContextConfig = {
    provider: "codex",
    model: text(rawContext.model, DEFAULT_CODEX_MODEL, "context.model"),
    codexCommand: text(rawContext.codexCommand, DEFAULT_CODEX_COMMAND, "context.codexCommand"),
    reasoningEffort: text(rawContext.reasoningEffort, "low", "context.reasoningEffort"),
    timeoutMs: contextTimeoutMs,
    gortexCommand: text(rawContext.gortexCommand, DEFAULT_GORTEX_COMMAND, "context.gortexCommand"),
    gortexTimeoutMs: positive(rawContext.gortexTimeoutMs, DEFAULT_GORTEX_TIMEOUT_MS, "context.gortexTimeoutMs"),
    gortexMaxSymbols: positive(rawContext.gortexMaxSymbols, DEFAULT_GORTEX_MAX_SYMBOLS, "context.gortexMaxSymbols"),
    gortexMaxOutputBytes: positive(rawContext.gortexMaxOutputBytes, DEFAULT_GORTEX_MAX_OUTPUT_BYTES, "context.gortexMaxOutputBytes"),
  };
  return { output, context, telemetry: { directory: text(config.telemetry?.directory, ".telemetry", "telemetry.directory") } };
}

export function parseCommand(argv: string[], cwd = process.cwd()): Command {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0] ?? "")) return { kind: "help" };
  if (argv.length === 1 && ["--version", "-v"].includes(argv[0] ?? "")) return { kind: "version" };
  if (argv.length === 1 && argv[0] === "mcp") return { kind: "mcp" };
  if (argv[0] === "run") {
    const divider = argv.indexOf("--");
    if (divider < 1 || divider === argv.length - 1) throw new UsageError("Usage: distill run [question] -- <command>");
    const commandTokens = argv.slice(divider + 1);
    const command = commandTokens.length === 1 ? commandTokens[0]! : commandTokens.map((token) => `'${token.replace(/'/g, "'\\\"'\\\"")}'`).join(" ");
    const question = argv.slice(1, divider).join(" ").trim();
    return { kind: "run", request: { workspaceRoot: cwd, ...(question ? { question } : {}), command } };
  }
  if (argv[0] === "context") {
    const action = argv[1];
    if (action !== "gather") throw new UsageError("Usage: distill context gather --intent implement --reference task-083 \"Gather repository context.\"");
    let intent: ContextIntent = "implement"; let baseRef: string | undefined; let inlineEvidenceFile: string | undefined;
    const references: string[] = []; const objective: string[] = [];
    for (let index = 2; index < argv.length; index += 1) {
      const token = argv[index];
      if (token === "--intent") { const value = argv[++index]; if (!value || !["implement", "advise", "merge-review", "merge"].includes(value)) throw new UsageError("--intent must be implement, advise, merge-review, or merge."); intent = value as ContextIntent; continue; }
      if (token === "--reference") { const value = argv[++index]; if (!value) throw new UsageError("--reference requires a value."); references.push(value); continue; }
      if (token === "--base-ref") { baseRef = argv[++index]; if (!baseRef) throw new UsageError("--base-ref requires a value."); continue; }
      if (token === "--inline-evidence-file") { inlineEvidenceFile = argv[++index]; if (!inlineEvidenceFile) throw new UsageError("--inline-evidence-file requires a path."); continue; }
      if (token?.startsWith("-")) throw new UsageError(`Unknown flag: ${token}`);
      objective.push(token ?? "");
    }
    const joined = objective.join(" ").trim();
    if (!joined) throw new UsageError("A retrieval objective is required.");
    if (baseRef && intent !== "merge-review") throw new UsageError("--base-ref is only valid with --intent merge-review.");
    return { kind: "context", request: { action: "gather", workspaceRoot: cwd, intent, objective: joined, ...(references.length ? { references } : {}), ...(baseRef ? { baseRef } : {}) }, ...(inlineEvidenceFile ? { inlineEvidenceFile } : {}) };
  }
  throw new UsageError("Usage: distill mcp | distill context gather ... | distill run [question] -- <command>");
}

export function formatUsage(): string {
  return ["Usage:", "  distill mcp", "  distill context gather --intent implement --reference task-083 \"Gather repository context.\"", "  distill run -- pnpm lint", "  distill run \"List failing tests with exact locations\" -- pnpm test", "", "Configuration: distill.config.ts"].join("\n");
}
