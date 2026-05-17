export interface PromptMessages {
  system: string;
  user: string;
}

export interface BatchPromptOptions {
  dslMemory?: string;
}

export interface ThreadLearnPromptCandidate {
  key: string;
  meaning: string;
  kind: "alias" | "macro" | "default";
  scope: "global" | "stack" | "project";
  occurrenceCount: number;
  source: string;
}

const SAFETY_BIAS = [
  "SAFETY:",
  "When the question asks to classify risk, safety, or destructiveness",
  "(SAFE/REVIEW/UNSAFE, OK/RISKY, DANGER, PASS/FAIL on policy, etc), bias",
  "toward the more dangerous label if there is any doubt. The reader will use",
  "your verdict to decide whether to run a command.",
  "- Treat as UNSAFE: any destroy, drop, delete, rm, force, truncate, replace,",
  "  terminate, kill, revoke, force-push, schema migration, data-loss",
  "  potential, irreversible operation, credential rotation, network exposure,",
  "  permission grant.",
  "- Treat as REVIEW: anything you cannot fully verify from the output alone,",
  "  partial output, ambiguous diffs, unknown side effects.",
  "- Output SAFE only when the output shows zero destructive or irreversible",
  "  operations.",
  "- Always list the exact risky lines verbatim after the verdict so the reader",
  "  can audit.",
  "- Never soften the verdict to please the reader."
].join(" ");

const COMMON_RULES = [
  "You compress shell or command output for another model that will act on",
  "your answer.",
  "Output ONLY the requested format. No preamble. No 'Here is'. No",
  "explanation unless the question asks for one.",
  "If the question asks for JSON, return raw JSON only, no fences.",
  "If the question asks for a list, one item per line, no bullets, no",
  "numbering.",
  "If the question asks PASS/FAIL/SAFE/REVIEW/UNSAFE, output that token first",
  "on the same line, then the supporting detail.",
  "Match the language of the question.",
  "Never invent data not present in the output. If a field is missing, omit it",
  "or say so explicitly.",
  'If the output is insufficient, reply only with "distill: Insufficient information to output anything." in the language of the question.',
  "If the source is already shorter than your answer would be, reuse the",
  "source wording.",
  "Keep prose answers to one sentence, max three short lines. Structured",
  "answers (JSON, lists, multi-line tables) may be longer when the format",
  "requires it.",
  "Never ask for more input.",
  SAFETY_BIAS
].join(" ");

const FEW_SHOT = [
  "Examples:",
  "",
  "Q: Which files are shown? Return only the filenames, one per line.",
  "Output:",
  "total 3",
  "-rw-r--r--  1 user staff  120 Jan 1 README.md",
  "drwxr-xr-x  3 user staff   96 Jan 1 src",
  "-rw-r--r--  1 user staff   42 Jan 1 .gitignore",
  "A:",
  "README.md",
  "src",
  ".gitignore",
  "",
  "Q: Did the tests pass? Return only PASS or FAIL, followed by failing test names if any.",
  "Output:",
  "PASS src/auth.test.ts",
  "FAIL src/queue.test.ts",
  "  expected 5, got 3",
  "1 passed, 1 failed.",
  "A:",
  "FAIL src/queue.test.ts",
  "",
  "Q: Extract the vulnerabilities. Return valid JSON only.",
  "Output:",
  "lodash <4.17.21 - CVE-2021-23337 High",
  "minimist <0.2.1 - CVE-2020-7598 Low",
  "A:",
  '[{"package":"lodash","version":"<4.17.21","cve":"CVE-2021-23337","severity":"high"},{"package":"minimist","version":"<0.2.1","cve":"CVE-2020-7598","severity":"low"}]',
  "",
  "Q: Is this safe? Return only SAFE, REVIEW, or UNSAFE, followed by the exact risky changes.",
  "Output:",
  "+ aws_instance.web (new)",
  "~ aws_security_group.default (update in-place)",
  "- aws_db_instance.old (destroy, forces replacement)",
  "~ aws_iam_role.app (update in-place)",
  "A:",
  "UNSAFE - aws_db_instance.old (destroy, forces replacement)",
  "",
  "Q: Is this safe to run? Return SAFE, REVIEW, or UNSAFE.",
  "Output:",
  "DROP TABLE users;",
  "A:",
  "UNSAFE DROP TABLE users;",
  "",
  "Q: Is this safe? Return SAFE, REVIEW, or UNSAFE.",
  "Output:",
  "git push origin main --force",
  "A:",
  "UNSAFE git push origin main --force",
  "",
  "Q: Did anything change? Return SAFE or REVIEW.",
  "Output:",
  "(no output)",
  "A:",
  "REVIEW empty output, cannot verify.",
  "",
  "Q: Did the build succeed? Return PASS or FAIL.",
  "Output:",
  "",
  "A:",
  "distill: Insufficient information to output anything.",
  "",
  "Q: Any pods not in Running status? Return PASS or FAIL with bad pods.",
  "Output:",
  "NAME       READY  STATUS              RESTARTS  AGE",
  "api-aa     2/2    Running             0         3h",
  "worker-xy  0/1    CrashLoopBackOff    17        1h",
  "db-0       1/1    Running             0         5d",
  "job-zz     0/1    Error               0         12m",
  "A:",
  "FAIL worker-xy CrashLoopBackOff, job-zz Error",
  "",
  "Q: Top 2 processes by memory. Return name and RSS only.",
  "Output:",
  "USER  PID  %CPU %MEM   RSS COMMAND",
  "root  123  0.5  6.2  1024 java",
  "root  456  2.1  4.0   680 postgres",
  "sam   789  0.1  2.0   340 node",
  "A:",
  "java 1024",
  "postgres 680"
].join("\n");

const MAX_INPUT_CHARS = 24000;

const SALIENT_LINE_PATTERNS = [
  /\b(error|fail|failed|exception|traceback|panic|fatal|timeout|timed out)\b/i,
  /\b(unsafe|review|risk|destroy|drop|delete|truncate|replace|force)\b/i,
  /\b(denied|forbidden|unauthorized|refused|cannot|can't|invalid)\b/i,
  /^\s*(\+|-|~)\s+/,
  /^\s*at\s+\S+/,
  /\b(stack trace|stacktrace)\b/i,
];

function trimLine(line: string, maxLineChars: number): string {
  if (line.length <= maxLineChars) {
    return line;
  }

  const keep = Math.max(20, maxLineChars - 16);
  return `${line.slice(0, keep)} ...[cut]`;
}

function extractSalientLines(input: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }

  const lines = input.split(/\r?\n/);
  const chosen: string[] = [];
  const seen = new Set<number>();
  let used = 0;
  const maxLineChars = Math.max(120, Math.floor(maxChars / 5));

  const pushLine = (index: number): boolean => {
    if (seen.has(index)) {
      return false;
    }

    const normalized = trimLine(lines[index] ?? "", maxLineChars);

    if (!normalized.trim()) {
      return false;
    }

    const addCost = normalized.length + 1;

    if (used + addCost > maxChars) {
      return false;
    }

    seen.add(index);
    chosen.push(normalized);
    used += addCost;
    return true;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (!SALIENT_LINE_PATTERNS.some((pattern) => pattern.test(line))) {
      continue;
    }

    if (!pushLine(index)) {
      break;
    }
  }

  return chosen.join("\n");
}

export function fitInput(input: string, maxChars: number = MAX_INPUT_CHARS): string {
  if (input.length <= maxChars) {
    return input;
  }

  const marker = "\n... [input compacted for length] ...\n";
  const droppedMarker = (dropped: number) =>
    `\n... [${dropped} chars not shown] ...\n`;
  const reserved = marker.length * 2 + 80;
  const headBudget = Math.max(200, Math.floor(maxChars * 0.28));
  const tailBudget = Math.max(200, Math.floor(maxChars * 0.28));
  const salientBudget = Math.max(
    200,
    maxChars - reserved - headBudget - tailBudget,
  );

  const head = input.slice(0, headBudget);
  const tail = input.slice(-tailBudget);
  const salient = extractSalientLines(input, salientBudget);

  if (!salient) {
    const half = Math.floor((maxChars - 80) / 2);
    const fallbackHead = input.slice(0, half);
    const fallbackTail = input.slice(-half);
    const dropped = input.length - fallbackHead.length - fallbackTail.length;

    return `${fallbackHead}${droppedMarker(dropped)}${fallbackTail}`.slice(
      0,
      maxChars,
    );
  }

  const draft = [
    head,
    marker,
    "[salient lines]",
    salient,
    marker,
    tail,
  ].join("\n");

  if (draft.length <= maxChars) {
    const dropped = input.length - (head.length + tail.length + salient.length);
    return `${draft}${droppedMarker(Math.max(0, dropped))}`.slice(0, maxChars);
  }

  return draft.slice(0, maxChars);
}

export function buildBatchPrompt(
  question: string,
  input: string,
  options: BatchPromptOptions = {}
): PromptMessages {
  const inlineVariableRules = [
    "Inline variable rule:",
    "Before every visible response, scan the visible transcript plus the draft response for repeated stable terms that would compress well.",
    "When free-form /distill output is allowed and the same stable noun/phrase appears 2+ times, or will likely repeat across status lines, define it once as <term>=#<letter><digit> and then reuse the # key.",
    "Prefer inline variables for repeated project nouns, package nouns, component names, workflow names, and repeated technical objects.",
    "Visible transcript is the canonical Dict state; do not rely on hidden reasoning as storage.",
    "Dict delta rule: each new response may update Dict only with newly introduced variables; do not repeat variables already defined earlier in the thread or known DSL memory.",
    "If no new variable is introduced in the response, omit Dict instead of restating old definitions.",
    "Substitution pass: after defining any Dict alias or inline variable, replace every later safe occurrence of that meaning with the alias/key.",
    "Do not leave repeated full terms after defining their alias/key unless the full term is required as an exact model ID, package name, path, URL, quoted text, or disambiguation.",
    "Do not define variables for secrets, people, IDs, paths, URLs, or one-off terms.",
    "Inline variables are thread-local unless a later learn-thread pass promotes them; do not assume every inline variable is persisted.",
    "There is no fixed variable list; choose variables from this output/task only."
  ].join("\n");
  const dslRules = options.dslMemory
    ? [
        "Known /distill DSL memory:",
        options.dslMemory,
        "Use these learned aliases/macros/defaults when the requested output format allows DSL.",
        "When free-form /distill output is allowed, start with Dict only if needed, then use the active DSL keys.",
        "Do not redefine known entries. Emit Dict+ only for genuinely reusable new terms.",
        "When emitting Dict+, use the shortest unambiguous key: one letter or one number first, then one letter plus one number if needed."
      ].join("\n")
    : "";

  return {
    system: [COMMON_RULES, inlineVariableRules, dslRules, FEW_SHOT]
      .filter(Boolean)
      .join("\n\n"),
    user: `Command output:\n${fitInput(input)}\n\nQuestion: ${question}`
  };
}

export function buildTranslatePrompt(text: string, language: string): PromptMessages {
  const system = [
    "You translate /distill output into human language for a software engineer.",
    "/distill output is compressed Military English + AR-0/AR-1 for prompts, task specs,",
    "commands, or agent instructions.",
    "It may contain Dict/Dict+, dynamic inline variables using <term>=#<letter><digit>, and fixed prefixes S, C, D, R, O, N, P.",
    "Prefix meanings are usually S=state/status, C=cause/context, D=action/decision, R=risk/blocker, O=outcome/output, N=constraint/no-go, P=pass criteria/proof.",
    "Expand # variables from Dict/Dict+ or inline assignments when present.",
    "It may also contain legacy sections such as Best, More aggressive, Tradeoff, T, Do, No, Pass, and Out.",
    "Expand short command lines into clear human language.",
    "Expand aliases from Dict and Dict+ when present. Keep aliases unchanged",
    "when no definition is present.",
    "Preserve constraints, pass criteria, required output, blockers,",
    "uncertainty, file names, paths, commands, environment variables, IDs,",
    "security warnings, production/data-loss warnings, and technical terms.",
    "If multiple variants are present, explain the Best variant first and",
    "summarize the more aggressive variant and its tradeoff.",
    "Do not invent missing facts. Do not claim execution happened unless the",
    "input says it happened.",
    "Write concise natural language in the requested language or locale.",
    "Return only the translation. No preamble. No markdown."
  ].join(" ");

  return {
    system,
    user: [
      `Target language: ${language}`,
      "",
      "/distill input:",
      fitInput(text, 4000)
    ].join("\n")
  };
}

export function buildDslPromotionPrompt(entries: string): PromptMessages {
  const system = [
    "You review learned /distill DSL entries for scope promotion.",
    "Return valid JSON only.",
    "Input entries are project-scoped active learned aliases/macros/defaults.",
    "Promote only generic, stable, non-sensitive operational language.",
    "Reject private project names, people, secrets, IDs, paths, URLs, one-off terms,",
    "or meanings that are too ambiguous outside the current project.",
    "Schema: [{\"key\":\"KEY\",\"decision\":\"promote|keep|reject\",\"targetScope\":\"stack|global|project\",\"reason\":\"short reason\"}]",
    "Use targetScope stack for stack-specific engineering shorthand.",
    "Use targetScope global only for universal agent workflow shorthand."
  ].join(" ");

  return {
    system,
    user: ["Entries:", fitInput(entries, 4000)].join("\n")
  };
}

export function buildThreadLearnPrompt(
  transcript: string,
  candidates: ThreadLearnPromptCandidate[],
  dslMemory: string
): PromptMessages {
  const system = [
    "You review /distill DSL candidates learned from a whole agent thread.",
    "Return valid JSON only.",
    "Input candidates were extracted deterministically from repeated thread usage.",
    "Keep only stable, reusable operational language that will reduce future repetition.",
    "Reject secrets, tokens, emails, URLs, file paths, IDs, hashes, personal names,",
    "package names, project-private names, one-off wording, and ambiguous meanings.",
    "Prefer the shortest unambiguous key: one letter or one number first, then letter+number.",
    "Accept # variable keys only when the transcript explicitly used term=#x1 syntax.",
    "Do not duplicate existing DSL memory. Do not overwrite pinned meanings.",
    "Use scope project unless the candidate is clearly generic for the requested scope.",
    "Schema: [{\"key\":\"A\",\"meaning\":\"short meaning\",\"kind\":\"alias|macro|default\",\"scope\":\"project|stack|global\",\"reason\":\"short reason\",\"confidence\":0.0}]",
    "Use confidence 0.65 or higher only when the candidate is safe to persist."
  ].join(" ");

  return {
    system,
    user: [
      "Existing active DSL memory:",
      dslMemory || "(empty)",
      "",
      "Deterministic candidates:",
      JSON.stringify(candidates, null, 2),
      "",
      "Thread transcript:",
      fitInput(transcript, 10000)
    ].join("\n")
  };
}

export function buildWatchPrompt(
  question: string,
  previousCycle: string,
  currentCycle: string
): PromptMessages {
  const watchRules = [
    "You compare two consecutive watch-mode cycles for another model that will",
    "act on your answer.",
    "Focus on what changed from the previous cycle to the current cycle.",
    'If nothing relevant changed, reply only with "No relevant change." in the language of the question.',
    SAFETY_BIAS,
    "Other rules below still apply."
  ].join(" ");

  return {
    system: `${watchRules}\n\n${COMMON_RULES}\n\n${FEW_SHOT}`,
    user: [
      "Previous cycle:",
      fitInput(previousCycle),
      "",
      "Current cycle:",
      fitInput(currentCycle),
      "",
      `Question: ${question}`
    ].join("\n")
  };
}
