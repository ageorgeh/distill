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
export const DEFAULT_DATASET_ENABLED = true;
export const DEFAULT_AUTO_LEARN = true;
export const DEFAULT_AUTO_LEARN_SCOPE = "project";
export const DEFAULT_AUTO_LEARN_SOURCE = "output";
export const DEFAULT_AUTO_PROMOTE_SCOPES = true;
export const DEFAULT_MAX_PROMPT_DSL_ENTRIES = 40;

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
  datasetEnabled: boolean;
  datasetPath?: string;
  autoLearn?: boolean;
  autoLearnScope?: "project";
  autoLearnSource?: "output";
  autoPromoteScopes?: boolean;
  maxPromptDslEntries?: number;
  debug?: boolean;
}

export interface RuntimeConfig extends DistillSettings {
  question: string;
}

export type PersistedConfig = Partial<DistillSettings> & {
  codexModel?: string;
  codexCommand?: string;
};

export type Command =
  | { kind: "onboard" }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "dsl"; args: string[] }
  | {
      kind: "translate";
      text: string;
      language: string;
      config: RuntimeConfig;
    }
  | { kind: "run"; config: RuntimeConfig };

export class UsageError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

function readFlagValue(
  argv: string[],
  index: number,
  name: string,
): { value: string; nextIndex: number } {
  const current = argv[index];
  const inline = current.slice(name.length + 1);

  if (inline.length > 0) {
    return { value: inline, nextIndex: index };
  }

  const next = argv[index + 1];

  if (!next) {
    throw new UsageError(`Missing value for ${name}.`);
  }

  return { value: next, nextIndex: index + 1 };
}

function coerceTimeout(input: string | undefined): number {
  const value = Number(input ?? DEFAULT_TIMEOUT_MS);

  if (!Number.isFinite(value) || value <= 0) {
    throw new UsageError("Timeout must be a positive number.");
  }

  return Math.floor(value);
}

function normalizeHost(input: string | undefined): string {
  const value = (input ?? DEFAULT_HOST).trim();

  if (!value) {
    throw new UsageError("Host cannot be empty.");
  }

  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function normalizeLocalHost(input: string | undefined): string {
  const value = (input ?? DEFAULT_LOCAL_HOST).trim();

  if (!value) {
    throw new UsageError("local-host cannot be empty.");
  }

  return value;
}

function coerceBoolean(input: string | boolean | undefined): boolean {
  if (typeof input === "boolean") {
    return input;
  }

  const value = String(input ?? DEFAULT_DATASET_ENABLED)
    .trim()
    .toLowerCase();

  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }

  throw new UsageError("Boolean values must be true or false.");
}

function coerceDebugBoolean(input: string | boolean | undefined): boolean {
  if (input === undefined) {
    return false;
  }

  return coerceBoolean(input);
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

  throw new UsageError("local-backend must be auto, mlx, or llamacpp.");
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
  arch = process.arch
): Exclude<LocalBackend, "auto"> {
  if (backend !== "auto") {
    return backend;
  }

  return platform === "darwin" && arch === "arm64" ? "mlx" : "llamacpp";
}

function resolveLocalModel(
  backend: LocalBackend,
  platform = process.platform,
  arch = process.arch
): string {
  return localBackendForPlatform(backend, platform, arch) === "mlx"
    ? DISTILL_MLX_MODEL
    : DISTILL_LLAMA_MODEL;
}

function resolveLocalHost(localHost: string, localPort: number): string {
  return `http://${localHost}:${localPort}/v1`;
}

export function resolveRuntimeDefaults(
  env: NodeJS.ProcessEnv,
  persisted: PersistedConfig,
): DistillSettings {
  const hasExternalEnv = Boolean(
    env.DISTILL_HOST || env.DISTILL_MODEL || env.DISTILL_API_KEY
  );
  const provider = env.DISTILL_PROVIDER
    ? coerceProvider(env.DISTILL_PROVIDER)
    : hasExternalEnv
      ? "external"
    : persisted.provider
      ? coercePersistedProvider(persisted.provider)
      : DEFAULT_PROVIDER;
  const localBackend = env.DISTILL_LOCAL_BACKEND
    ? coerceLocalBackend(env.DISTILL_LOCAL_BACKEND)
    : coercePersistedLocalBackend(persisted.localBackend);
  const localConcurrency = coercePositiveInteger(
    env.DISTILL_LOCAL_CONCURRENCY ??
      persisted.localConcurrency ??
      DEFAULT_LOCAL_CONCURRENCY,
    "local-concurrency"
  );
  const localHost = normalizeLocalHost(
    env.DISTILL_LOCAL_HOST ?? persisted.localHost ?? DEFAULT_LOCAL_HOST
  );
  const localPort = coercePort(
    env.DISTILL_LOCAL_PORT ?? persisted.localPort ?? DEFAULT_LOCAL_PORT,
    "local-port"
  );
  const model = provider === "local"
    ? resolveLocalModel(localBackend)
    : provider === "codex"
      ? env.DISTILL_CODEX_MODEL ?? persisted.codexModel ?? DEFAULT_CODEX_MODEL
      : env.DISTILL_MODEL ?? persisted.model ?? DEFAULT_MODEL;
  const host =
    provider === "local"
      ? resolveLocalHost(localHost, localPort)
      : normalizeHost(env.DISTILL_HOST ?? persisted.host ?? DEFAULT_HOST);
  const apiKey = provider === "local" ? "" : env.DISTILL_API_KEY ?? persisted.apiKey ?? "";
  const codexCommand =
    env.DISTILL_CODEX_COMMAND ?? persisted.codexCommand ?? DEFAULT_CODEX_COMMAND;
  const timeoutMs = coerceTimeout(
    env.DISTILL_TIMEOUT_MS ?? String(persisted.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  );
  const datasetEnabled = coerceBoolean(
    env.DISTILL_DATASET_ENABLED ?? persisted.datasetEnabled,
  );
  const datasetPath = env.DISTILL_DATASET_PATH ?? persisted.datasetPath;
  const autoLearn = coerceBoolean(
    env.DISTILL_AUTO_LEARN ?? persisted.autoLearn ?? DEFAULT_AUTO_LEARN,
  );
  const autoPromoteScopes = coerceBoolean(
    env.DISTILL_AUTO_PROMOTE_SCOPES ??
      persisted.autoPromoteScopes ??
      DEFAULT_AUTO_PROMOTE_SCOPES,
  );
  const maxPromptDslEntries = coercePositiveInteger(
    env.DISTILL_MAX_PROMPT_DSL_ENTRIES ??
      persisted.maxPromptDslEntries ??
      DEFAULT_MAX_PROMPT_DSL_ENTRIES,
    "max-prompt-dsl-entries",
  );
  const debug = coerceDebugBoolean(env.DISTILL_DEBUG);

  return {
    provider,
    localBackend,
    localConcurrency,
    localHost,
    localPort,
    model,
    host,
    apiKey,
    ...(provider === "codex" ? { codexCommand } : {}),
    timeoutMs,
    datasetEnabled,
    datasetPath,
    autoLearn,
    autoLearnScope: DEFAULT_AUTO_LEARN_SCOPE,
    autoLearnSource: DEFAULT_AUTO_LEARN_SOURCE,
    autoPromoteScopes,
    maxPromptDslEntries,
    debug,
  };
}

export function parseCommand(
  argv: string[],
  env: NodeJS.ProcessEnv,
  persisted: PersistedConfig = {},
): Command {
  if (argv.length === 1 && argv[0] === "onboard") {
    return { kind: "onboard" };
  }

  if (argv[0] === "config") {
    throw new UsageError("The config command was removed. Edit distill.config.ts instead.");
  }

  if (argv[0] === "dsl") {
    return { kind: "dsl", args: argv.slice(1) };
  }

  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return { kind: "help" };
  }

  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    return { kind: "version" };
  }

  const defaults = resolveRuntimeDefaults(env, persisted);

  if (argv[0] === "translate") {
    if (!argv[1]?.trim()) {
      throw new UsageError("/distill text is required.");
    }

    if (argv.length > 3) {
      throw new UsageError("Usage: distill translate <text> [language]");
    }

    return {
      kind: "translate",
      text: argv[1],
      language: argv[2] ?? "en-US",
      config: {
        question: "Translate /distill output into human language.",
        provider: defaults.provider,
        localBackend: defaults.localBackend,
        localConcurrency: defaults.localConcurrency,
        localHost: defaults.localHost,
        localPort: defaults.localPort,
        model: defaults.model,
        host: defaults.host,
        apiKey: defaults.apiKey,
        ...(defaults.provider === "codex" ? { codexCommand: defaults.codexCommand } : {}),
        timeoutMs: defaults.timeoutMs,
        datasetEnabled: defaults.datasetEnabled,
        datasetPath: defaults.datasetPath,
        autoLearn: defaults.autoLearn,
        autoLearnScope: defaults.autoLearnScope,
        autoLearnSource: defaults.autoLearnSource,
        autoPromoteScopes: defaults.autoPromoteScopes,
        maxPromptDslEntries: defaults.maxPromptDslEntries,
        debug: defaults.debug,
      },
    };
  }

  let timeoutMs = defaults.timeoutMs;
  let providerOverride: Provider | undefined;
  let modelOverride: string | undefined;
  let hostOverride: string | undefined;
  let apiKeyOverride: string | undefined;
  const questionParts: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--") {
      questionParts.push(...argv.slice(index + 1));
      break;
    }

    if (token === "--model" || token.startsWith("--model=")) {
      const parsed = readFlagValue(argv, index, "--model");
      modelOverride = parsed.value;
      index = parsed.nextIndex;
      continue;
    }

    if (token === "--host" || token.startsWith("--host=")) {
      const parsed = readFlagValue(argv, index, "--host");
      hostOverride = parsed.value;
      index = parsed.nextIndex;
      continue;
    }

    if (token === "--api-key" || token.startsWith("--api-key=")) {
      const parsed = readFlagValue(argv, index, "--api-key");
      apiKeyOverride = parsed.value;
      index = parsed.nextIndex;
      continue;
    }

    if (token === "--provider" || token.startsWith("--provider=")) {
      const parsed = readFlagValue(argv, index, "--provider");
      providerOverride = coerceProvider(parsed.value);
      index = parsed.nextIndex;
      continue;
    }

    if (token === "--timeout-ms" || token.startsWith("--timeout-ms=")) {
      const parsed = readFlagValue(argv, index, "--timeout-ms");
      timeoutMs = coerceTimeout(parsed.value);
      index = parsed.nextIndex;
      continue;
    }

    if (token === "--debug") {
      defaults.debug = true;
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

  if (providerOverride === "codex" && (hostOverride !== undefined || apiKeyOverride !== undefined)) {
    throw new UsageError("--host and --api-key are incompatible with --provider codex.");
  }

  const provider =
    providerOverride ??
    (modelOverride || hostOverride || apiKeyOverride
      ? modelOverride && !hostOverride && !apiKeyOverride &&
        (defaults.provider === "ollama" || defaults.provider === "codex")
        ? defaults.provider
        : "external"
      : defaults.provider);
  const model =
    provider === "codex"
      ? modelOverride ?? env.DISTILL_CODEX_MODEL ?? persisted.codexModel ?? DEFAULT_CODEX_MODEL
      : provider === "external" || provider === "ollama"
      ? modelOverride ?? env.DISTILL_MODEL ?? persisted.model ?? DEFAULT_MODEL
      : defaults.model;
  const host =
    provider === "external" || provider === "ollama"
      ? normalizeHost(hostOverride ?? env.DISTILL_HOST ?? persisted.host ?? DEFAULT_HOST)
      : defaults.host;
  const apiKey =
    provider === "external" || provider === "ollama"
      ? apiKeyOverride ?? env.DISTILL_API_KEY ?? persisted.apiKey ?? ""
      : "";

  return {
    kind: "run",
    config: {
      question,
      provider,
      localBackend: defaults.localBackend,
      localConcurrency: defaults.localConcurrency,
      localHost: defaults.localHost,
      localPort: defaults.localPort,
      model,
      host,
      apiKey,
      ...(provider === "codex" ? {
        codexCommand:
          env.DISTILL_CODEX_COMMAND ?? persisted.codexCommand ?? DEFAULT_CODEX_COMMAND
      } : {}),
      timeoutMs,
      datasetEnabled: defaults.datasetEnabled,
      datasetPath: defaults.datasetPath,
      autoLearn: defaults.autoLearn,
      autoLearnScope: defaults.autoLearnScope,
      autoLearnSource: defaults.autoLearnSource,
      autoPromoteScopes: defaults.autoPromoteScopes,
      maxPromptDslEntries: defaults.maxPromptDslEntries,
      debug: defaults.debug,
    },
  };
}

export function formatUsage(): string {
  return [
    "Usage:",
    '  cmd 2>&1 | distill "question"',
    "  distill onboard",
    "  Edit distill.config.ts for persistent configuration",
    "  distill dsl show",
    "  distill dsl show --candidates",
    '  distill dsl learn --dry-run "Dict+: A1=auth fix"',
    "  distill dsl promote --dry-run",
    '  distill dsl add alias A1 "auth fix" --scope project',
    '  distill translate "Best: Fix auth bug. Pass: tests pass." [language]',
    '  distill --host http://127.0.0.1:1234/v1 --model my-model "summarize"',
    "",
    "Options:",
    "  --provider <name>     Provider: local, ollama, external, or codex",
    `  --model <name>        API model name (default Ollama model: ${DEFAULT_MODEL})`,
    `  --host <url>          OpenAI-compatible base URL (default Ollama: ${DEFAULT_HOST})`,
    "  --api-key <key>       API key (env: DISTILL_API_KEY)",
    `  Codex defaults: ${DEFAULT_CODEX_COMMAND}, ${DEFAULT_CODEX_MODEL}`,
    "  DISTILL_CODEX_COMMAND=<path>  Codex CLI executable",
    "  DISTILL_CODEX_MODEL=<name>    Codex CLI model",
    `  --timeout-ms <ms>     Request timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})`,
    "  --debug               Print fallback reasons to stderr (env: DISTILL_DEBUG=true)",
    "",
    "Local model defaults:",
    `  DISTILL_PROVIDER=ollama          Use your existing Ollama OpenAI-compatible service`,
    `  DISTILL_PROVIDER=external        Use any other OpenAI-compatible API`,
    `  DISTILL_LOCAL_BACKEND=mlx        Override local backend: auto, mlx, llamacpp`,
    `  DISTILL_LOCAL_CONCURRENCY=5      Max concurrent local model requests`,
    `  DISTILL_LOCAL_PORT=${DEFAULT_LOCAL_PORT}       Local model server port`,
    "",
    "Local fine-tuning capture (enabled by default):",
    "  Successful batch summaries are appended as JSONL under the config dir",
    "  (input + completion). The file is created with mode 0600.",
    "  DISTILL_DATASET_ENABLED=false  Disable local JSONL dataset capture",
    "  DISTILL_DATASET_PATH=<path>    Override dataset JSONL path",
    "  DISTILL_AUTO_LEARN=false       Disable project-scoped DSL auto-learn",
    "  DISTILL_MAX_PROMPT_DSL_ENTRIES=<n>  Limit DSL entries injected into prompts",
    "  --help                Show usage",
    "  --version             Show version",
  ].join("\n");
}
