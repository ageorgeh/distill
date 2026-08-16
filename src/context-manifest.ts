import { toJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";

const text = (limit: number) => v.pipe(v.string(), v.minLength(1), v.maxLength(limit));
const priority = v.picklist([1, 2, 3]);
const source = v.strictObject({
  path: text(1_024),
  startLine: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  endLine: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});
const finding = v.strictObject({ text: text(900), priority, source: v.optional(source) });
const observation = v.strictObject({
  text: text(900),
  startLine: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  endLine: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});
const excerpt = v.strictObject({ startLine: v.pipe(v.number(), v.integer(), v.minValue(1)), endLine: v.pipe(v.number(), v.integer(), v.minValue(1)), reason: text(400) });
const contextFile = v.strictObject({
  path: text(1_024),
  role: v.picklist(["edit", "caller", "test", "documentation", "generated", "configuration", "changed", "conflict"]),
  inspected: v.boolean(),
  relevance: text(600),
  priority,
  observations: v.array(observation),
  excerpts: v.array(excerpt),
});
const search = v.strictObject({ query: text(500), scope: v.optional(text(600)), result: text(900), priority });
const concern = v.strictObject({
  id: v.pipe(text(64), v.regex(/^[a-z0-9][a-z0-9-]*$/)),
  title: text(160),
  summary: text(800),
  priority,
  dependencies: v.array(v.pipe(text(64), v.regex(/^[a-z0-9][a-z0-9-]*$/))),
  findings: v.array(finding),
  files: v.array(contextFile),
  searchesCompleted: v.array(search),
  validation: v.array(text(1_000)),
  gaps: v.array(text(900)),
});

export const contextManifestSchema = v.strictObject({
  scope: text(800),
  globalFindings: v.array(finding),
  globalFiles: v.array(contextFile),
  globalSearchesCompleted: v.array(search),
  globalValidation: v.array(text(1_000)),
  globalGaps: v.array(text(900)),
  concerns: v.array(concern),
});

export type ContextPriority = v.InferOutput<typeof priority>;
export type ContextSource = v.InferOutput<typeof source>;
export type ContextFinding = v.InferOutput<typeof finding>;
export type ContextObservation = v.InferOutput<typeof observation>;
export type ContextExcerptRequest = v.InferOutput<typeof excerpt>;
export type ContextFile = v.InferOutput<typeof contextFile>;
export type ContextSearch = v.InferOutput<typeof search>;
export type ContextConcern = v.InferOutput<typeof concern>;
export type ContextManifest = v.InferOutput<typeof contextManifestSchema>;
export const contextManifestJsonSchema = toJsonSchema(contextManifestSchema);

/** Codex requires every object field to be required, so source optionality is nullable at the protocol edge. */
function codexSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(codexSchema);
  if (!schema || typeof schema !== "object") return schema;
  const result = { ...(schema as Record<string, unknown>) };
  if (result.type === "object" && result.properties && typeof result.properties === "object") {
    const required = new Set(Array.isArray(result.required) ? result.required.filter((value): value is string => typeof value === "string") : []);
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(result.properties as Record<string, unknown>)) {
      const converted = codexSchema(value);
      properties[key] = required.has(key) ? converted : { anyOf: [converted, { type: "null" }] };
      required.add(key);
    }
    result.properties = properties;
    result.required = [...required];
    result.additionalProperties = false;
  }
  for (const [key, value] of Object.entries(result)) if (key !== "properties" && key !== "required") result[key] = codexSchema(value);
  return result;
}

export const codexContextManifestJsonSchema = codexSchema(contextManifestJsonSchema);

function omitNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitNulls);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, nested]) => nested !== null).map(([key, nested]) => [key, omitNulls(nested)]));
}

function executable(command: string): boolean {
  return /^[a-zA-Z0-9_./][^\n]*$/.test(command) && !/^(none|n\/a|unknown|not run)$/i.test(command.trim());
}

function validateFiles(files: ContextFile[]): void {
  for (const file of files) if (!file.inspected && (file.observations.length || file.excerpts.length)) throw new Error(`Uninspected file ${file.path} contains evidence.`);
}

export function parseContextManifest(value: unknown): ContextManifest {
  const manifest = v.parse(contextManifestSchema, omitNulls(value));
  const ids = new Set<string>();
  for (const item of manifest.concerns) {
    if (ids.has(item.id)) throw new Error(`Duplicate concern ID: ${item.id}.`);
    ids.add(item.id);
    validateFiles(item.files);
    if (item.validation.some((command) => !executable(command))) throw new Error(`Concern ${item.id} has a non-executable validation command.`);
  }
  validateFiles(manifest.globalFiles);
  if (manifest.globalValidation.some((command) => !executable(command))) throw new Error("Global validation contains a non-executable command.");
  for (const item of manifest.concerns) for (const dependency of item.dependencies) {
    if (dependency === item.id) throw new Error(`Concern ${item.id} cannot depend on itself.`);
    if (!ids.has(dependency)) throw new Error(`Concern ${item.id} depends on missing concern ${dependency}.`);
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  const byId = new Map(manifest.concerns.map((item) => [item.id, item]));
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error(`Concern dependency cycle includes ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id); for (const dependency of byId.get(id)!.dependencies) visit(dependency); visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
  return manifest;
}
