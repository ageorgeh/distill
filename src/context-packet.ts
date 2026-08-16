import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ContextConcern, ContextFile, ContextFinding, ContextManifest, ContextPriority } from "./context-manifest";

export type RequiredBefore = "any-edit" | "concern" | "optional";
export interface ContextPacket {
  id: string;
  concernId: string | null;
  part: number;
  parts: number;
  requiredBefore: RequiredBefore;
  dependencies: string[];
  bytes: number;
  text: string;
  blockIds: string[];
}
export interface StoredContextBundle {
  version: 1;
  contextId: string;
  createdAt: string;
  workspaceRoot: string;
  manifest: ContextManifest;
  packets: ContextPacket[];
}
export interface NormalizationResult { manifest: ContextManifest; validation: string[]; }
interface ResolvedFile { relative: string; lines: string[]; }
interface PacketBlock { id: string; priority: ContextPriority; text: string; }

const ROLE_ORDER: Record<ContextFile["role"], number> = { edit: 0, conflict: 1, changed: 2, caller: 3, test: 4, generated: 5, configuration: 6, documentation: 7 };
const bytes = (value: string) => Buffer.byteLength(value);
const key = (value: string) => value.replace(/[^a-zA-Z0-9-]/g, "-");

async function resolveFile(root: string, candidate: string): Promise<ResolvedFile | undefined> {
  const absolute = path.resolve(root, candidate);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  try {
    if (!(await stat(absolute)).isFile()) return undefined;
    return { relative: relative.split(path.sep).join("/"), lines: (await readFile(absolute, "utf8")).split(/\r?\n/) };
  } catch { return undefined; }
}

function mergeRanges<T extends { startLine: number; endLine: number }>(ranges: T[]): T[] {
  const result: T[] = [];
  for (const range of [...ranges].sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine)) {
    const previous = result.at(-1);
    if (previous && range.startLine <= previous.endLine + 1) previous.endLine = Math.max(previous.endLine, range.endLine);
    else result.push({ ...range });
  }
  return result;
}

function unique<T>(items: T[], value: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => { const itemKey = value(item); if (seen.has(itemKey)) return false; seen.add(itemKey); return true; });
}

async function normalizeFiles(root: string, files: ContextFile[], gaps: string[], validation: string[]): Promise<ContextFile[]> {
  const merged = new Map<string, ContextFile>();
  for (const input of files) {
    const resolved = await resolveFile(root, input.path);
    if (!resolved) {
      validation.push(`Dropped missing or outside file: ${input.path}`);
      if (input.inspected) gaps.push(`Repository evidence for ${input.path} was unavailable; use a targeted source read if this owner is needed.`);
      continue;
    }
    const observations = input.observations.flatMap((observation) => {
      if (observation.startLine === undefined && observation.endLine === undefined) return [observation];
      if (observation.startLine === undefined || observation.endLine === undefined || observation.startLine > observation.endLine || observation.startLine > resolved.lines.length) {
        validation.push(`Dropped invalid observation range in ${resolved.relative}`); return [{ text: observation.text }];
      }
      return [{ ...observation, endLine: Math.min(observation.endLine, resolved.lines.length) }];
    });
    const excerpts = input.excerpts.flatMap((request) => {
      if (request.startLine > request.endLine || request.startLine > resolved.lines.length) { validation.push(`Dropped invalid excerpt range in ${resolved.relative}`); return []; }
      if (request.endLine > resolved.lines.length) validation.push(`Clamped excerpt range in ${resolved.relative}`);
      return [{ ...request, endLine: Math.min(request.endLine, resolved.lines.length) }];
    });
    const normalized: ContextFile = { ...input, path: resolved.relative, observations, excerpts };
    const existing = merged.get(resolved.relative);
    if (!existing) { merged.set(resolved.relative, normalized); continue; }
    const role = ROLE_ORDER[normalized.role] < ROLE_ORDER[existing.role] ? normalized.role : existing.role;
    existing.role = role;
    existing.inspected ||= normalized.inspected;
    existing.priority = Math.min(existing.priority, normalized.priority) as ContextPriority;
    existing.relevance = unique([existing.relevance, normalized.relevance], (item) => item).join("; ");
    existing.observations = unique([...existing.observations, ...normalized.observations], (item) => `${item.text}:${item.startLine ?? ""}:${item.endLine ?? ""}`);
    existing.excerpts = mergeRanges(unique([...existing.excerpts, ...normalized.excerpts], (item) => `${item.startLine}:${item.endLine}:${item.reason}`));
  }
  return [...merged.values()];
}

async function normalizeFindings(root: string, findings: ContextFinding[], validation: string[]): Promise<ContextFinding[]> {
  return Promise.all(findings.map(async (finding) => {
    if (!finding.source) return finding;
    const resolved = await resolveFile(root, finding.source.path);
    if (!resolved || (finding.source.startLine && finding.source.startLine > resolved.lines.length) || (finding.source.startLine && finding.source.endLine && finding.source.endLine < finding.source.startLine)) {
      validation.push(`Dropped invalid finding source: ${finding.source.path}`); return { text: finding.text, priority: finding.priority };
    }
    return { ...finding, source: { ...finding.source, path: resolved.relative, ...(finding.source.endLine && finding.source.startLine ? { endLine: Math.min(finding.source.endLine, resolved.lines.length) } : {}) } };
  }));
}

export async function normalizeContextManifest(workspaceRoot: string, manifest: ContextManifest): Promise<NormalizationResult> {
  const validation: string[] = [];
  const globalGaps = [...manifest.globalGaps];
  const globalFiles = await normalizeFiles(workspaceRoot, manifest.globalFiles, globalGaps, validation);
  const concerns: ContextConcern[] = [];
  for (const concern of manifest.concerns) {
    const gaps = [...concern.gaps];
    concerns.push({ ...concern, findings: await normalizeFindings(workspaceRoot, concern.findings, validation), files: await normalizeFiles(workspaceRoot, concern.files, gaps, validation), gaps });
  }
  return { manifest: { ...manifest, globalFindings: await normalizeFindings(workspaceRoot, manifest.globalFindings, validation), globalFiles, globalGaps, concerns }, validation };
}

function sourceBlocks(id: string, file: ContextFile, lines: string[]): PacketBlock[] {
  const blocks: PacketBlock[] = [];
  for (const request of file.excerpts) {
    const excerptLines = lines.slice(request.startLine - 1, request.endLine).map((line, index) => `${request.startLine + index} | ${line}`);
    blocks.push({ id: `${id}:excerpt:${request.startLine}-${request.endLine}`, priority: file.priority, text: `EXACT SOURCE\n${file.path}:${request.startLine}-${request.endLine} — ${request.reason}\n${excerptLines.join("\n")}` });
  }
  return blocks;
}

async function fileBlocks(root: string, prefix: string, files: ContextFile[]): Promise<PacketBlock[]> {
  const blocks: PacketBlock[] = [];
  for (const [index, file] of files.entries()) {
    const id = `${prefix}:file:${index}:${key(file.path)}`;
    const details = file.observations.map((item) => `- ${item.text}${item.startLine ? ` (${item.startLine}${item.endLine ? `-${item.endLine}` : ""})` : ""}`);
    blocks.push({ id, priority: file.priority, text: file.inspected ? `INSPECTED\n${file.path}\n${details.length ? details.join("\n") : `- ${file.relevance}`}` : `RELATED\n${file.path} — ${file.relevance}` });
    if (file.inspected && file.excerpts.length) {
      const resolved = await resolveFile(root, file.path);
      if (resolved) blocks.push(...sourceBlocks(id, file, resolved.lines));
    }
  }
  return blocks;
}

function commonBlocks(prefix: string, findings: ContextFinding[], searches: ContextManifest["globalSearchesCompleted"], validation: string[], gaps: string[]): PacketBlock[] {
  const blocks: PacketBlock[] = [];
  findings.forEach((finding, index) => blocks.push({ id: `${prefix}:finding:${index}`, priority: finding.priority, text: `FINDINGS\n- ${finding.text}${finding.source ? ` (${finding.source.path}${finding.source.startLine ? `:${finding.source.startLine}${finding.source.endLine ? `-${finding.source.endLine}` : ""}` : ""})` : ""}` }));
  searches.forEach((search, index) => blocks.push({ id: `${prefix}:search:${index}`, priority: search.priority, text: `SEARCHES DONE\n${search.query}${search.scope ? ` under ${search.scope}` : ""}\n- ${search.result}` }));
  validation.forEach((command, index) => blocks.push({ id: `${prefix}:validate:${index}`, priority: 2, text: `VALIDATE\n${command}` }));
  gaps.forEach((gap, index) => blocks.push({ id: `${prefix}:gap:${index}`, priority: 1, text: `GAPS\n- ${gap}` }));
  return blocks;
}

function splitSourceBlock(block: PacketBlock, budget: number): PacketBlock[] {
  if (bytes(block.text) <= budget) return [block];
  const lines = block.text.split("\n");
  const match = /^(.+):(\d+)-(\d+) — (.+)$/.exec(lines[1] ?? "");
  if (!match) throw new Error(`Cannot split non-source semantic block ${block.id}.`);
  const [, sourcePath, , , reason] = match;
  const code = lines.slice(2);
  const result: PacketBlock[] = []; let current: string[] = [];
  for (const line of code) {
    const lineNumber = /^(\d+) \|/.exec(line)?.[1];
    const start = /^(\d+) \|/.exec(current[0] ?? line)?.[1];
    const label = `EXACT SOURCE\n${sourcePath}:${start ?? lineNumber}-${lineNumber} — ${reason}`;
    if (bytes(`${label}\n${[...current, line].join("\n")}`) > budget && current.length) {
      const chunkStart = /^(\d+) \|/.exec(current[0]!)?.[1]; const chunkEnd = /^(\d+) \|/.exec(current.at(-1)!)?.[1];
      result.push({ ...block, id: `${block.id}:part:${result.length + 1}`, text: `EXACT SOURCE\n${sourcePath}:${chunkStart}-${chunkEnd} — ${reason}\n${current.join("\n")}\n[source continues]` }); current = [];
    }
    if (bytes(`EXACT SOURCE\n${sourcePath}:${lineNumber}-${lineNumber} — ${reason}\n${line}`) > budget) throw new Error(`Source line in ${block.id} exceeds the result budget.`);
    current.push(line);
  }
  if (current.length) {
    const chunkStart = /^(\d+) \|/.exec(current[0]!)?.[1]; const chunkEnd = /^(\d+) \|/.exec(current.at(-1)!)?.[1];
    result.push({ ...block, id: `${block.id}:part:${result.length + 1}`, text: `EXACT SOURCE\n${sourcePath}:${chunkStart}-${chunkEnd} — ${reason}\n${current.join("\n")}` });
  }
  return result;
}

function packPackets(contextId: string, baseId: string, concernId: string | null, requiredBefore: RequiredBefore, dependencies: string[], blocks: PacketBlock[], budget: number): ContextPacket[] {
  const prepared = blocks.sort((left, right) => left.priority - right.priority).flatMap((block) => splitSourceBlock(block, budget - 180));
  const chunks: PacketBlock[][] = []; let current: PacketBlock[] = [];
  for (const block of prepared) {
    if (bytes(block.text) > budget - 180) throw new Error(`Semantic block ${block.id} exceeds the result budget.`);
    const candidate = [...current, block];
    if (current.length && bytes(candidate.map((item) => item.text).join("\n\n")) > budget - 180) { chunks.push(current); current = [block]; }
    else current = candidate;
  }
  if (current.length || !chunks.length) chunks.push(current);
  return chunks.map((chunk, index) => {
    const id = `${baseId}-${index + 1}`;
    const header = `CONTEXT v2 id=${contextId} packet=${id} part=${index + 1}/${chunks.length}${concernId ? `\nCONCERN ${concernId}` : "\nGLOBAL"}${dependencies.length ? `\nDEPENDENCIES ${dependencies.join(", ")}` : ""}`;
    const text = [header, ...chunk.map((item) => item.text), index + 1 < chunks.length ? `NEXT ${baseId}-${index + 2}` : ""].filter(Boolean).join("\n\n");
    return { id, concernId, part: index + 1, parts: chunks.length, requiredBefore, dependencies, bytes: bytes(text), text, blockIds: chunk.map((item) => item.id) };
  });
}

function indexBlocks(scope: string, global: ContextPacket[], concerns: Array<{ concern: ContextConcern; packets: ContextPacket[] }>): PacketBlock[] {
  return [
    { id: "index:scope", priority: 1, text: `SCOPE\n${scope}` },
    { id: "index:spark", priority: 1, text: "SPARK\nrepository pass complete; later packet retrieval does not rerun Spark" },
    ...(global.length ? [{ id: "index:global", priority: 1 as ContextPriority, text: `GLOBAL\n${global.map((packet) => packet.id).join(", ")} required before any edit` }] : []),
    ...concerns.map(({ concern, packets }) => ({ id: `index:concern:${concern.id}`, priority: concern.priority, text: `CONCERNS\n${concern.id}\n  packets: ${packets.map((packet) => packet.id).join(", ")}\n  dependencies: ${concern.dependencies.length ? concern.dependencies.join(", ") : "none"}\n  fetch before working on this concern` })),
    { id: "index:gaps", priority: 1, text: "GAPS\nnone" },
    { id: "index:usage", priority: 1, text: "USAGE\nCall context with action=packet, this context id, and a packet id. Fetch global packets before the first edit; fetch a concern and dependency packets before exploring or editing it." },
  ];
}

export async function buildContextBundle(options: { contextId: string; workspaceRoot: string; manifest: ContextManifest; resultByteBudget: number; createdAt?: string }): Promise<{ bundle: StoredContextBundle; normalization: string[] }> {
  const normalized = await normalizeContextManifest(options.workspaceRoot, options.manifest);
  const globalBlocks = [...commonBlocks("global", normalized.manifest.globalFindings, normalized.manifest.globalSearchesCompleted, normalized.manifest.globalValidation, normalized.manifest.globalGaps), ...await fileBlocks(options.workspaceRoot, "global", normalized.manifest.globalFiles)];
  const globalPackets = globalBlocks.length ? packPackets(options.contextId, "global", null, "any-edit", [], globalBlocks, options.resultByteBudget) : [];
  const concernPackets = [] as Array<{ concern: ContextConcern; packets: ContextPacket[] }>;
  for (const concern of normalized.manifest.concerns) {
    const blocks = [{ id: `concern:${concern.id}:summary`, priority: concern.priority, text: `SUMMARY\n${concern.summary}` }, ...commonBlocks(`concern:${concern.id}`, concern.findings, concern.searchesCompleted, concern.validation, concern.gaps), ...await fileBlocks(options.workspaceRoot, `concern:${concern.id}`, concern.files)];
    concernPackets.push({ concern, packets: packPackets(options.contextId, concern.id, concern.id, "concern", [], blocks, options.resultByteBudget) });
  }
  const byConcern = new Map(concernPackets.map((item) => [item.concern.id, item.packets]));
  for (const { concern, packets } of concernPackets) for (const packet of packets) {
    packet.dependencies = [...globalPackets.map((item) => item.id), ...concern.dependencies.flatMap((id) => byConcern.get(id)?.map((item) => item.id) ?? [])];
    if (packet.dependencies.length) {
      packet.text = packet.text.replace(`CONCERN ${concern.id}`, `CONCERN ${concern.id}\nDEPENDENCIES ${packet.dependencies.join(", ")}`);
      packet.bytes = bytes(packet.text);
    }
  }
  const indexPackets = packPackets(options.contextId, "index", null, "optional", [], indexBlocks(normalized.manifest.scope, globalPackets, concernPackets), options.resultByteBudget);
  const packets = [...indexPackets, ...globalPackets, ...concernPackets.flatMap((item) => item.packets)];
  if (packets.some((packet) => packet.bytes > options.resultByteBudget)) throw new Error("Context packet exceeded the parent result budget.");
  const ids = packets.flatMap((packet) => packet.blockIds); const expected = [...indexPackets.flatMap((packet) => packet.blockIds), ...globalPackets.flatMap((packet) => packet.blockIds), ...concernPackets.flatMap((item) => item.packets.flatMap((packet) => packet.blockIds))];
  if (ids.length !== new Set(ids).size || ids.length !== expected.length) throw new Error("Context packet completeness invariant failed.");
  return { bundle: { version: 1, contextId: options.contextId, createdAt: options.createdAt ?? new Date().toISOString(), workspaceRoot: options.workspaceRoot, manifest: normalized.manifest, packets }, normalization: normalized.validation };
}
