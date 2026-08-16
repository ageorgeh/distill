import { readFile } from "node:fs/promises";
import path from "node:path";
import { DISTILL_VERSION, UsageError, formatUsage, parseCommand, resolveConfig } from "./config";
import { createContextHandler } from "./context";
import { serveMcp } from "./mcp";
import { createRunHandler } from "./run-command";
import { readPersistedConfig } from "./user-config";

async function main(): Promise<number> {
  const cwd = path.resolve(process.cwd());
  const command = parseCommand(process.argv.slice(2), cwd);
  if (command.kind === "help") { process.stdout.write(`${formatUsage()}\n`); return 0; }
  if (command.kind === "version") { process.stdout.write(`${DISTILL_VERSION}\n`); return 0; }
  const config = resolveConfig(await readPersistedConfig(cwd));
  if (command.kind === "mcp") { await serveMcp(config); return 0; }
  if (command.kind === "run") { process.stdout.write(`${await createRunHandler(config)(command.request)}\n`); return 0; }
  const request = command.inlineEvidenceFile ? { ...command.request, inlineEvidence: await readFile(path.resolve(cwd, command.inlineEvidenceFile), "utf8") } : command.request;
  process.stdout.write(`${await createContextHandler(config)(request)}\n`);
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  if (error instanceof UsageError) { process.stderr.write(`${error.message}\n\n${formatUsage()}\n`); process.exit(error.exitCode); }
  process.stderr.write(`${error instanceof Error ? error.message : "Unexpected error."}\n`);
  process.exit(1);
});
