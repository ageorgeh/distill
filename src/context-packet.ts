import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ContextManifest } from "./context-manifest";

export interface PacketResult { packet: string; gaps: string[]; invalidEntries: string[]; }
interface FileEntry { path: string; role: ContextManifest["files"][number]["role"]; reason: string; priority: 1 | 2 | 3; includeExcerpt: boolean; ranges: Array<{ startLine: number; endLine: number }>; lines: string[]; }

function byteLength(value: string): number { return Buffer.byteLength(value); }
function utf8Fit(value: string, bytes: number): string {
  if (byteLength(value) <= bytes) return value;
  let end = Math.min(value.length, bytes);
  while (end > 0 && byteLength(value.slice(0, end)) > bytes) end -= 1;
  return value.slice(0, end);
}
function mergeRanges(ranges: Array<{ startLine: number; endLine: number }>): Array<{ startLine: number; endLine: number }> {
  const result: Array<{ startLine: number; endLine: number }> = [];
  for (const range of [...ranges].sort((a, b) => a.startLine - b.startLine)) {
    const last = result.at(-1);
    if (last && range.startLine <= last.endLine + 1) last.endLine = Math.max(last.endLine, range.endLine);
    else result.push({ ...range });
  }
  return result;
}
function section(name: string, values: string[]): string { return `${name}\n${values.length ? values.join("\n") : "none"}`; }
function compact(values: string[], maxItems: number, maxBytes: number): string[] {
  const selected: string[] = []; let used = 0;
  for (const value of values) {
    if (selected.length >= maxItems) break;
    const clipped = utf8Fit(value, Math.max(24, Math.min(360, maxBytes - used)));
    if (!clipped) break;
    selected.push(clipped); used += byteLength(clipped) + 1;
    if (used >= maxBytes) break;
  }
  return selected;
}

async function resolveFile(root: string, candidate: string): Promise<{ absolute: string; relative: string; lines: string[] } | undefined> {
  const absolute = path.resolve(root, candidate);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  try {
    if (!(await stat(absolute)).isFile()) return undefined;
    return { absolute, relative: relative.split(path.sep).join("/"), lines: (await readFile(absolute, "utf8")).split(/\r?\n/) };
  } catch { return undefined; }
}

export async function assembleContextPacket(options: { id: string; workspaceRoot: string; manifest: ContextManifest; resultByteBudget: number }): Promise<PacketResult> {
  const gaps = [...options.manifest.gaps];
  const invalidEntries: string[] = [];
  const files: FileEntry[] = [];
  for (const entry of options.manifest.files) {
    const resolved = await resolveFile(options.workspaceRoot, entry.path);
    if (!resolved) { const message = `Missing or outside workspace: ${entry.path}`; gaps.push(message); invalidEntries.push(message); continue; }
    const ranges: Array<{ startLine: number; endLine: number }> = [];
    let invalid = false;
    for (const range of entry.ranges ?? []) {
      if (range.startLine < 1 || range.endLine < range.startLine || range.endLine > resolved.lines.length) { invalid = true; break; }
      ranges.push(range);
    }
    if (invalid) { const message = `Invalid evidence range in ${entry.path}`; gaps.push(message); invalidEntries.push(message); continue; }
    files.push({ ...entry, path: resolved.relative, ranges: mergeRanges(ranges), lines: resolved.lines });
  }
  for (const note of options.manifest.notes) {
    if (!note.source) continue;
    const resolved = await resolveFile(options.workspaceRoot, note.source.path);
    if (!resolved || (note.source.startLine && note.source.startLine > resolved.lines.length) || (note.source.endLine && note.source.endLine > resolved.lines.length) || (note.source.startLine && note.source.endLine && note.source.endLine < note.source.startLine)) { const message = `Invalid note evidence: ${note.source.path}`; gaps.push(message); invalidEntries.push(message); }
  }
  const notes = (kinds: ContextManifest["notes"][number]["kind"][]) => options.manifest.notes.filter((note) => kinds.includes(note.kind)).sort((a, b) => a.priority - b.priority).map((note) => `- ${note.text}`);
  const contract = notes(["rule", "requirement", "acceptance", "out_of_scope"]);
  const workstreams = notes(["workstream"]);
  const risks = notes(["risk", "finding"]);
  const fileLines = files.sort((a, b) => a.priority - b.priority).map((file) => `${file.role.toUpperCase()} ${file.path} — ${file.reason}`);
  const header = `CONTEXT v1 id=${options.id}`;
  // Keep important contracts and gaps small enough to reserve room for every required section.
  const required = [
    header,
    section("TASK", [utf8Fit(options.manifest.summary, 700)]),
    section("CONTRACT", compact(contract, 8, 1_800)),
    section("GAPS", gaps.length ? compact(gaps.map((gap) => `- ${gap}`), 8, 1_000) : ["none"]),
    section("RISKS", compact(risks, 6, 1_000)),
    section("WORKSTREAMS", compact(workstreams, 8, 1_200)),
    section("FILES", compact(fileLines, 12, 1_400)),
    section("VALIDATE", compact(options.manifest.validation, 8, 700)),
  ];
  let packet = required.join("\n\n");
  const excerpts: string[] = [];
  const budgetForExcerpts = Math.max(0, options.resultByteBudget - byteLength(packet) - 14);
  let remaining = budgetForExcerpts;
  for (const file of files.filter((item) => item.includeExcerpt).sort((a, b) => a.priority - b.priority)) {
    for (const range of file.ranges) {
      const excerpt = `${file.path}:${range.startLine}-${range.endLine}\n${file.lines.slice(range.startLine - 1, range.endLine).map((line, index) => `${range.startLine + index} | ${line}`).join("\n")}`;
      const cost = byteLength(excerpt) + (excerpts.length ? 1 : 0);
      if (cost <= remaining) { excerpts.push(excerpt); remaining -= cost; }
    }
  }
  packet = [...required, section("EXCERPTS", excerpts)].join("\n\n");
  if (byteLength(packet) > options.resultByteBudget) {
    // Mandatory evidence has precedence; preserve valid UTF-8 and make the cap explicit.
    packet = utf8Fit(packet, Math.max(0, options.resultByteBudget - 18)).trimEnd() + "\n[packet compacted]";
  }
  return { packet, gaps, invalidEntries };
}
