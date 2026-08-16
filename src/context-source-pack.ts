import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ContextExcerptRequest, ContextFile, ContextManifest, ContextPriority } from "./context-manifest";

interface ResolvedFile { relative: string; lines: string[]; }
interface SourceCandidate {
  id: string;
  path: string;
  role: ContextFile["role"];
  priority: ContextPriority;
  startLine: number;
  endLine: number;
  reason: string;
  text: string;
}

export interface ContextSourcePack {
  text: string;
  bytes: number;
  broad: boolean;
  targetByteBudget: number;
  hardByteBudget: number;
  manifest: ContextManifest;
  normalization: string[];
  includedSources: string[];
  omittedSources: string[];
}

const TARGET_RESULT_TOKENS = 10_000;
const BYTES_PER_TOKEN = 4;
const MAX_SOURCE_CHUNK_LINES = 80;
const ROLE_ORDER: Record<ContextFile["role"], number> = { edit: 0, changed: 1, conflict: 2, caller: 3, test: 4, generated: 5, configuration: 6, documentation: 7 };
const DIRECT_ROLES = new Set<ContextFile["role"]>(["edit", "changed", "conflict"]);
const bytes = (value: string) => Buffer.byteLength(value);

async function resolveFile(root: string, candidate: string): Promise<ResolvedFile | undefined> {
  const absolute = path.resolve(root, candidate);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  try {
    if (!(await stat(absolute)).isFile()) return undefined;
    return { relative: relative.split(path.sep).join("/"), lines: (await readFile(absolute, "utf8")).split(/\r?\n/) };
  } catch { return undefined; }
}

function mergeRanges(ranges: ContextExcerptRequest[]): ContextExcerptRequest[] {
  const merged: ContextExcerptRequest[] = [];
  for (const range of [...ranges].sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine)) {
    const previous = merged.at(-1);
    if (!previous || range.startLine > previous.endLine + 1) { merged.push({ ...range }); continue; }
    previous.endLine = Math.max(previous.endLine, range.endLine);
    if (!previous.reason.includes(range.reason)) previous.reason = `${previous.reason}; ${range.reason}`;
  }
  return merged;
}

function unique(items: string[]): string[] { return [...new Set(items)]; }

export async function normalizeContextManifest(workspaceRoot: string, manifest: ContextManifest): Promise<{ manifest: ContextManifest; validation: string[] }> {
  const validation: string[] = [];
  const merged = new Map<string, ContextFile>();
  for (const input of manifest.files) {
    const resolved = await resolveFile(workspaceRoot, input.path);
    if (!resolved) { validation.push(`Ignored missing or outside file: ${input.path}`); continue; }
    const excerpts = input.excerpts.flatMap((request) => {
      if (request.startLine > request.endLine || request.startLine > resolved.lines.length) {
        validation.push(`Ignored invalid excerpt in ${resolved.relative}:${request.startLine}-${request.endLine}`);
        return [];
      }
      const endLine = Math.min(request.endLine, resolved.lines.length);
      if (endLine !== request.endLine) validation.push(`Clamped excerpt in ${resolved.relative}:${request.startLine}-${request.endLine}`);
      if (endLine - request.startLine + 1 > MAX_SOURCE_CHUNK_LINES) validation.push(`Split broad excerpt in ${resolved.relative}:${request.startLine}-${endLine}`);
      return [{ ...request, endLine }];
    });
    if (!excerpts.length) continue;
    const normalized: ContextFile = { ...input, path: resolved.relative, excerpts };
    const existing = merged.get(resolved.relative);
    if (!existing) { merged.set(resolved.relative, normalized); continue; }
    if (ROLE_ORDER[normalized.role] < ROLE_ORDER[existing.role]) existing.role = normalized.role;
    existing.priority = Math.min(existing.priority, normalized.priority) as ContextPriority;
    existing.relevance = unique([existing.relevance, normalized.relevance]).join("; ");
    existing.excerpts.push(...normalized.excerpts);
  }
  const files = [...merged.values()]
    .map((file) => ({ ...file, excerpts: mergeRanges(file.excerpts) }))
    .sort((left, right) => left.priority - right.priority || ROLE_ORDER[left.role] - ROLE_ORDER[right.role] || left.path.localeCompare(right.path));
  return { manifest: { ...manifest, files }, validation };
}

async function sourceCandidates(workspaceRoot: string, files: ContextFile[]): Promise<SourceCandidate[]> {
  const result: SourceCandidate[] = [];
  for (const file of files) {
    const resolved = await resolveFile(workspaceRoot, file.path);
    if (!resolved) continue;
    for (const excerpt of file.excerpts) {
      for (let startLine = excerpt.startLine; startLine <= excerpt.endLine; startLine += MAX_SOURCE_CHUNK_LINES) {
        const endLine = Math.min(excerpt.endLine, startLine + MAX_SOURCE_CHUNK_LINES - 1);
        const source = resolved.lines.slice(startLine - 1, endLine).map((line, index) => `${startLine + index} | ${line}`).join("\n");
        const text = `EXACT SOURCE\n${file.path}:${startLine}-${endLine} — ${excerpt.reason}\n${source}`;
        const id = `${file.path}:${startLine}-${endLine}`;
        result.push({ id, path: file.path, role: file.role, priority: file.priority, startLine, endLine, reason: excerpt.reason, text });
      }
    }
  }
  return result;
}

function balancedCandidates(files: ContextFile[], candidates: SourceCandidate[]): SourceCandidate[] {
  const byPath = new Map(files.map((file) => [file.path, candidates.filter((candidate) => candidate.path === file.path)]));
  const firstDirect = files.filter((file) => DIRECT_ROLES.has(file.role)).flatMap((file) => byPath.get(file.path)?.slice(0, 1) ?? []);
  const firstSupporting = files.filter((file) => !DIRECT_ROLES.has(file.role)).flatMap((file) => byPath.get(file.path)?.slice(0, 1) ?? []);
  const firstIds = new Set([...firstDirect, ...firstSupporting].map((candidate) => candidate.id));
  const remaining = candidates.filter((candidate) => !firstIds.has(candidate.id));
  const byPriority = (left: SourceCandidate, right: SourceCandidate) => left.priority - right.priority || ROLE_ORDER[left.role] - ROLE_ORDER[right.role] || left.path.localeCompare(right.path) || left.startLine - right.startLine;
  const remainingDirect = remaining.filter((candidate) => DIRECT_ROLES.has(candidate.role)).sort(byPriority);
  const remainingSupporting = remaining.filter((candidate) => !DIRECT_ROLES.has(candidate.role)).sort(byPriority);
  return [...firstDirect, ...remainingDirect, ...firstSupporting, ...remainingSupporting];
}

function boundedMetadata(manifest: ContextManifest, allowance: number): string[] {
  const limit = Math.min(12_000, Math.max(1_500, Math.floor(allowance / 4)));
  const parts: string[] = [];
  const add = (part: string) => {
    const candidate = [...parts, part].join("\n\n");
    if (bytes(candidate) <= limit) parts.push(part);
  };
  const fileLines = manifest.files.map((file) => {
    const ranges = file.excerpts.map((excerpt) => `${excerpt.startLine}-${excerpt.endLine}`).join(",");
    return `[${file.role} p${file.priority}] ${file.path}:${ranges} — ${file.relevance}`;
  });
  if (fileLines.length) add(`FILES LOCATED\n${fileLines.join("\n")}`);
  for (const search of manifest.searchesCompleted) add(`SEARCH COMPLETED\n${search.query}${search.scope ? ` under ${search.scope}` : ""}\n${search.matches.map((match) => `- ${match}`).join("\n")}`);
  if (manifest.validation.length) add(`VALIDATE\n${manifest.validation.join("\n")}`);
  return parts;
}

export async function buildContextSourcePack(options: { contextId: string; workspaceRoot: string; manifest: ContextManifest; resultByteBudget: number }): Promise<ContextSourcePack> {
  const normalized = await normalizeContextManifest(options.workspaceRoot, options.manifest);
  const hardByteBudget = Math.max(1_000, options.resultByteBudget);
  const targetByteBudget = Math.min(TARGET_RESULT_TOKENS * BYTES_PER_TOKEN, hardByteBudget);
  const candidates = await sourceCandidates(options.workspaceRoot, normalized.manifest.files);
  const directFiles = normalized.manifest.files.filter((file) => DIRECT_ROLES.has(file.role)).length;
  const candidateBytes = candidates.reduce((total, candidate) => total + bytes(candidate.text) + 2, 0);
  const broad = directFiles > 6 || normalized.manifest.files.length > 12 || candidateBytes > targetByteBudget;
  const allowance = broad ? hardByteBudget : targetByteBudget;
  const header = `DISTILL CONTEXT id=${options.contextId}\nRepository discovery and initial source reading are complete. Treat exact source below as already read; make only targeted follow-up reads when editing requires surrounding code.`;
  const metadata = boundedMetadata(normalized.manifest, allowance);
  const selected: SourceCandidate[] = [];
  const omitted: SourceCandidate[] = [];
  for (const candidate of balancedCandidates(normalized.manifest.files, candidates)) {
    const text = [header, ...metadata, ...selected.map((item) => item.text), candidate.text].join("\n\n");
    if (bytes(text) <= allowance) selected.push(candidate);
    else omitted.push(candidate);
  }
  const parts = [header, ...metadata, ...selected.map((candidate) => candidate.text)];
  if (omitted.length) {
    const lines: string[] = [];
    for (const candidate of omitted) {
      const line = `${candidate.path}:${candidate.startLine}-${candidate.endLine} — ${candidate.reason}`;
      const additional = `ADDITIONAL LOCATED SOURCE\n${[...lines, line].join("\n")}`;
      if (bytes([...parts, additional].join("\n\n")) > allowance) break;
      lines.push(line);
    }
    if (lines.length) parts.push(`ADDITIONAL LOCATED SOURCE\n${lines.join("\n")}`);
  }
  const text = parts.join("\n\n");
  return {
    text,
    bytes: bytes(text),
    broad,
    targetByteBudget,
    hardByteBudget,
    manifest: normalized.manifest,
    normalization: normalized.validation,
    includedSources: selected.map((candidate) => candidate.id),
    omittedSources: omitted.map((candidate) => candidate.id),
  };
}
