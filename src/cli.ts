import {
  DISTILL_VERSION,
  UsageError,
  formatUsage,
  parseCommand,
  resolveRuntimeDefaults,
} from "./config";
import {
  formatPromptDslMemory,
  learnFromDistillOutput,
  readMergedDslMemory,
  runDslCommand,
  type DslPromotionReview,
  type DslThreadLearnReview,
} from "./dsl-memory";
import {
  summarizeBatch,
  summarizeDslPromotion,
  summarizeThreadLearn,
  summarizeTranslate,
  summarizeWatch,
} from "./llm";
import { runOnboarding } from "./onboarding";
import { DistillSession, type ProgressPhase } from "./stream-distiller";
import { resolveDatasetPath } from "./dataset";
import {
  readPersistedConfig,
} from "./user-config";

async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new UsageError("stdin is required.");
  }

  const chunks: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    process.stdin.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    process.stdin.on("end", resolve);
    process.stdin.on("error", reject);
    process.stdin.resume();
  });

  return Buffer.concat(chunks).toString("utf8");
}

function debugRuntime(config: import("./config").RuntimeConfig, mode: string): void {
  if (!config.debug) return;

  const transport = config.provider === "codex"
    ? `command=${JSON.stringify(config.codexCommand ?? "codex")}`
    : config.provider === "local"
      ? `backend=${config.localBackend} endpoint=${JSON.stringify(config.host)} concurrency=${config.localConcurrency}`
      : `endpoint=${JSON.stringify(config.host)}`;

  process.stderr.write(
    `distill: debug: runtime version=${DISTILL_VERSION} mode=${mode} provider=${config.provider} model=${JSON.stringify(config.model)} timeout_ms=${config.timeoutMs} ${transport}\n`,
  );
  process.stderr.write(
    `distill: debug: features dataset=${config.datasetEnabled ? "enabled" : "disabled"} auto_learn=${config.autoLearn === false ? "disabled" : "enabled"} max_dsl_entries=${config.maxPromptDslEntries ?? 40}\n`,
  );
}

async function run(): Promise<number> {
  const persisted = await readPersistedConfig(process.env);
  const command = parseCommand(process.argv.slice(2), process.env, persisted);

  if (command.kind === "onboard") {
    await runOnboarding({ env: process.env, persisted });
    return 0;
  }

  if (command.kind === "help") {
    process.stdout.write(`${formatUsage()}\n`);
    return 0;
  }

  if (command.kind === "version") {
    process.stdout.write(`${DISTILL_VERSION}\n`);
    return 0;
  }

  if (command.kind === "dsl") {
    const defaults = resolveRuntimeDefaults(process.env, persisted);
    const runtimeConfig = {
      question: "Review DSL memory.",
      provider: defaults.provider,
      localBackend: defaults.localBackend,
      localConcurrency: defaults.localConcurrency,
      localHost: defaults.localHost,
      localPort: defaults.localPort,
      model: defaults.model,
      host: defaults.host,
      apiKey: defaults.apiKey,
      timeoutMs: defaults.timeoutMs,
      datasetEnabled: defaults.datasetEnabled,
      datasetPath: defaults.datasetPath,
      autoLearn: defaults.autoLearn,
      autoLearnScope: defaults.autoLearnScope,
      autoLearnSource: defaults.autoLearnSource,
      autoPromoteScopes: defaults.autoPromoteScopes,
      maxPromptDslEntries: defaults.maxPromptDslEntries,
    };
    process.stdout.write(
      await runDslCommand(command.args, {
        env: process.env,
        cwd: process.cwd(),
        readStdin: readAllStdin,
        promotionReviewer: async (entries) => {
          const response = await summarizeDslPromotion(
            { ...runtimeConfig, question: "Review DSL promotion candidates." },
            entries
              .map(
                (entry) =>
                  `${entry.key}\t${entry.kind}\t${entry.meaning}\tuses=${entry.useCount}`,
              )
              .join("\n"),
          );

          return JSON.parse(response) as DslPromotionReview[];
        },
        threadLearnReviewer: async (request) => {
          const dslMemory = formatPromptDslMemory(
            request.dslMemory,
            defaults.maxPromptDslEntries ?? 40,
          );
          const response = await summarizeThreadLearn(
            { ...runtimeConfig, question: "Review thread DSL candidates." },
            request.transcript,
            request.candidates,
            dslMemory,
          );

          return JSON.parse(response) as DslThreadLearnReview[];
        },
      }),
    );
    return 0;
  }

  if (command.kind === "translate") {
    debugRuntime(command.config, "translate");
    const startedAt = Date.now();
    const output = await summarizeTranslate(
      command.config,
      command.text,
      command.language,
    );
    if (command.config.debug) {
      process.stderr.write(
        `distill: debug: request=translate status=success output_bytes=${Buffer.byteLength(output)} elapsed_ms=${Date.now() - startedAt}\n`,
      );
    }
    process.stdout.write(`${output}\n`);
    return 0;
  }

  if (process.stdin.isTTY) {
    throw new UsageError("stdin is required.");
  }

  debugRuntime(command.config, "stream");

  const progressProtocol = process.env.DISTILL_PROGRESS_PROTOCOL === "stderr";
  const mergedDslMemory = await readMergedDslMemory(
    process.env,
    process.cwd(),
    undefined,
  );
  const promptDslMemory = formatPromptDslMemory(
    mergedDslMemory,
    command.config.maxPromptDslEntries ?? 40,
  );
  const progress = progressProtocol
    ? undefined
    : process.stderr.isTTY
      ? process.stderr
      : process.stdout.isTTY
        ? process.stdout
        : undefined;
  const emitProgressPhase = progressProtocol
    ? (phase: ProgressPhase) => {
        process.stderr.write(`__DISTILL_PROGRESS__:phase:${phase}\n`);
      }
    : undefined;
  const emitProgressStop = progressProtocol
    ? () => {
        process.stderr.write("__DISTILL_PROGRESS__:stop\n");
      }
    : undefined;
  const session = new DistillSession({
    summarizer: {
      summarizeBatch: (input) =>
        summarizeBatch(command.config, input, { dslMemory: promptDslMemory }),
      summarizeWatch: (previous, current) =>
        summarizeWatch(command.config, previous, current),
    },
    runtimeConfig: command.config,
    dataset: {
      enabled: command.config.datasetEnabled,
      path: resolveDatasetPath(process.env, command.config.datasetPath),
    },
    stdout: process.stdout,
    stderr: process.stderr,
    isTTY: Boolean(process.stdout.isTTY),
    progress,
    onProgressPhase: emitProgressPhase,
    onProgressStop: emitProgressStop,
    debug: command.config.debug === true,
    onBatchOutput:
      command.config.autoLearn !== false
        ? (output) =>
            learnFromDistillOutput(process.env, process.cwd(), output, {
              stack: undefined,
            }).then(() => undefined)
        : undefined,
  });

  await new Promise<void>((resolve, reject) => {
    process.stdin.on("data", (chunk) => {
      session.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    process.stdin.on("end", resolve);
    process.stdin.on("error", reject);
    process.stdin.resume();
  });

  await session.end();
  return 0;
}

run()
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${formatUsage()}\n`);
      process.exit(error.exitCode);
    }

    process.stderr.write(
      error instanceof Error ? `${error.message}\n` : "Unexpected error.\n",
    );
    process.exit(1);
  });
