import cliPackage from "../packages/cli/package.json";

export const DISTILL_VERSION = cliPackage.version;

export const DEFAULT_MODEL = "qwen3.5:4b";
export const DEFAULT_CODEX_MODEL = "gpt-5.3-codex-spark";
export const DEFAULT_CODEX_COMMAND = "codex";
export const DEFAULT_HOST = "http://127.0.0.1:11434/v1";
export const DEFAULT_TIMEOUT_MS = 90_000;
export const DEFAULT_PROVIDER = "local";
export const DEFAULT_LOCAL_BACKEND = "auto";
export const DEFAULT_LOCAL_CONCURRENCY = 5;
export const DEFAULT_LOCAL_HOST = "127.0.0.1";
export const DEFAULT_LOCAL_PORT = 8009;
export const DISTILL_MLX_MODEL = "samuelfaj/distill-1.7B-4bit-MLX";
export const DISTILL_LLAMA_MODEL = "distill-local";
export const DEFAULT_IDLE_MS = 1_200;
export const DEFAULT_INTERACTIVE_GAP_MS = 180;
export const DEFAULT_PROGRESS_FRAME_MS = 120;

export type Provider = "local" | "ollama" | "external" | "codex";
export type LocalBackend = "auto" | "mlx" | "llamacpp";

export interface DistillSettings {
  provider: Provider;
  localBackend: LocalBackend;
  localConcurrency: number;
  localHost: string;
  localPort: number;
  model: string;
  host: string;
  apiKey: string;
  codexCommand?: string;
  timeoutMs: number;
}

export interface RuntimeConfig extends DistillSettings {
  question: string;
  debug?: boolean;
}

export type PersistedConfig = Partial<DistillSettings> & {
  codexModel?: string;
};

export type Command =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "translate"; text: string; language: string; config: RuntimeConfig }
  | { kind: "run"; config: RuntimeConfig };

export class UsageError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

function coerceTimeout(input: string | number | undefined): number {
  const value = Number(input ?? DEFAULT_TIMEOUT_MS);

  if (!Number.isFinite(value) || value <= 0) {
    throw new UsageError("timeoutMs must be a positive number.");
  }

  return Math.floor(value);
}

function normalizeHost(input: string | undefined): string {
  const value = (input ?? DEFAULT_HOST).trim();

  if (!value) {
    throw new UsageError("host cannot be empty.");
  }

  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function normalizeLocalHost(input: string | undefined): string {
  const value = (input ?? DEFAULT_LOCAL_HOST).trim();

  if (!value) {
    throw new UsageError("localHost cannot be empty.");
  }

  return value;
}

function coercePositiveInteger(
  input: string | number | undefined,
  label: string,
): number {
  const value = Number(input);

  if (!Number.isInteger(value) || value <= 0) {
    throw new UsageError(`${label} must be a positive integer.`);
  }

  return value;
}

function coercePort(input: string | number | undefined, label: string): number {
  const value = coercePositiveInteger(input, label);

  if (value > 65_535) {
    throw new UsageError(`${label} must be between 1 and 65535.`);
  }

  return value;
}

function coerceProvider(input: string | undefined): Provider {
  const value = (input ?? DEFAULT_PROVIDER).trim().toLowerCase();

  if (value === "local" || value === "ollama" || value === "external" || value === "codex") {
    return value;
  }

  throw new UsageError("provider must be local, ollama, external, or codex.");
}

function coercePersistedProvider(input: string | undefined): Provider {
  try {
    return coerceProvider(input);
  } catch {
    return DEFAULT_PROVIDER;
  }
}

function coerceLocalBackend(input: string | undefined): LocalBackend {
  const value = (input ?? DEFAULT_LOCAL_BACKEND).trim().toLowerCase();

  if (value === "auto" || value === "mlx" || value === "llamacpp") {
    return value;
  }

  throw new UsageError("localBackend must be auto, mlx, or llamacpp.");
}

function coercePersistedLocalBackend(input: string | undefined): LocalBackend {
  try {
    return coerceLocalBackend(input);
  } catch {
    return DEFAULT_LOCAL_BACKEND;
  }
}

function localBackendForPlatform(
  backend: LocalBackend,
  platform = process.platform,
  arch = process.arch,
): Exclude<LocalBackend, "auto"> {
  if (backend !== "auto") {
    return backend;
  }

  return platform === "darwin" && arch === "arm64" ? "mlx" : "llamacpp";
}

function resolveLocalModel(
  backend: LocalBackend,
  platform = process.platform,
  arch = process.arch,
): string {
  return localBackendForPlatform(backend, platform, arch) === "mlx"
    ? DISTILL_MLX_MODEL
    : DISTILL_LLAMA_MODEL;
}

function resolveLocalHost(localHost: string, localPort: number): string {
  return `http://${localHost}:${localPort}/v1`;
}

/** Resolve the one supported configuration source: distill.config.ts. */
export function resolveRuntimeDefaults(persisted: PersistedConfig): DistillSettings {
  const provider = coercePersistedProvider(persisted.provider);
  const localBackend = coercePersistedLocalBackend(persisted.localBackend);
  const localConcurrency = coercePositiveInteger(
    persisted.localConcurrency ?? DEFAULT_LOCAL_CONCURRENCY,
    "localConcurrency",
  );
  const localHost = normalizeLocalHost(persisted.localHost);
  const localPort = coercePort(
    persisted.localPort ?? DEFAULT_LOCAL_PORT,
    "localPort",
  );
  const model =
    provider === "local"
      ? resolveLocalModel(localBackend)
      : provider === "codex"
        ? persisted.codexModel ?? persisted.model ?? DEFAULT_CODEX_MODEL
        : persisted.model ?? DEFAULT_MODEL;
  const host =
    provider === "local"
      ? resolveLocalHost(localHost, localPort)
      : normalizeHost(persisted.host);
  const apiKey = provider === "local" ? "" : persisted.apiKey ?? "";
  const timeoutMs = coerceTimeout(persisted.timeoutMs);

  return {
    provider,
    localBackend,
    localConcurrency,
    localHost,
    localPort,
    model,
    host,
    apiKey,
    ...(provider === "codex"
      ? { codexCommand: persisted.codexCommand ?? DEFAULT_CODEX_COMMAND }
      : {}),
    timeoutMs,
  };
}

function runtimeConfig(defaults: DistillSettings, question: string): RuntimeConfig {
  return { ...defaults, question };
}

export function parseCommand(
  argv: string[],
  persisted: PersistedConfig = {},
): Command {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return { kind: "help" };
  }

  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    return { kind: "version" };
  }

  const defaults = resolveRuntimeDefaults(persisted);

  if (argv[0] === "translate") {
    let debug = false;
    const translateArgs: string[] = [];

    for (const token of argv.slice(1)) {
      if (token === "--debug") {
        debug = true;
        continue;
      }

      if (token.startsWith("-")) {
        throw new UsageError(`Unknown flag: ${token}`);
      }

      translateArgs.push(token);
    }

    if (!translateArgs[0]?.trim()) {
      throw new UsageError("/distill text is required.");
    }

    if (translateArgs.length > 2) {
      throw new UsageError("Usage: distill translate <text> [language]");
    }

    return {
      kind: "translate",
      text: translateArgs[0],
      language: translateArgs[1] ?? "en-US",
      config: {
        ...runtimeConfig(defaults, "Translate /distill output into human language."),
        debug,
      },
    };
  }

  let debug = false;
  const questionParts: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--") {
      questionParts.push(...argv.slice(index + 1));
      break;
    }

    if (token === "--debug") {
      debug = true;
      continue;
    }

    if (token.startsWith("-")) {
      throw new UsageError(`Unknown flag: ${token}`);
    }

    questionParts.push(token);
  }

  const question = questionParts.join(" ").trim();

  if (!question) {
    throw new UsageError("A question is required.");
  }

  return {
    kind: "run",
    config: { ...runtimeConfig(defaults, question), debug },
  };
}

export function formatUsage(): string {
  return [
    "Usage:",
    '  cmd 2>&1 | distill "question"',
    '  distill translate "distill output" [language]',
    "  Edit distill.config.ts for persistent configuration",
    "",
    "Options:",
    "  --debug               Print fallback and request diagnostics to stderr",
    "  --help                Show usage",
    "  --version             Show version",
  ].join("\n");
}
