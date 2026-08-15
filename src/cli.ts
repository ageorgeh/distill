import {
  DISTILL_VERSION,
  UsageError,
  formatUsage,
  parseCommand,
} from "./config";
import {
  summarizeBatch,
  summarizeTranslate,
  summarizeWatch,
} from "./llm";
import { DistillSession, type ProgressPhase } from "./stream-distiller";
import { readPersistedConfig } from "./user-config";

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
}

async function run(): Promise<number> {
  const persisted = await readPersistedConfig();
  const command = parseCommand(process.argv.slice(2), persisted);

  if (command.kind === "help") {
    process.stdout.write(`${formatUsage()}\n`);
    return 0;
  }

  if (command.kind === "version") {
    process.stdout.write(`${DISTILL_VERSION}\n`);
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
      summarizeBatch: (input) => summarizeBatch(command.config, input),
      summarizeWatch: (previous, current) =>
        summarizeWatch(command.config, previous, current),
    },
    stdout: process.stdout,
    stderr: process.stderr,
    isTTY: Boolean(process.stdout.isTTY),
    progress,
    onProgressPhase: emitProgressPhase,
    onProgressStop: emitProgressStop,
    debug: command.config.debug === true,
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
