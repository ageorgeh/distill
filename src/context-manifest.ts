import { toJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";

const text = (limit: number) => v.pipe(v.string(), v.minLength(1), v.maxLength(limit));
const priority = v.picklist([1, 2, 3]);
const excerpt = v.strictObject({
  startLine: v.pipe(v.number(), v.integer(), v.minValue(1)),
  endLine: v.pipe(v.number(), v.integer(), v.minValue(1)),
  reason: text(300),
});
const contextFile = v.strictObject({
  path: text(1_024),
  role: v.picklist(["edit", "caller", "test", "documentation", "generated", "configuration", "changed", "conflict"]),
  relevance: text(400),
  priority,
  excerpts: v.pipe(v.array(excerpt), v.minLength(1), v.maxLength(8)),
});
const search = v.strictObject({
  query: text(500),
  scope: v.optional(text(600)),
  matches: v.pipe(v.array(text(500)), v.minLength(1), v.maxLength(20)),
});

/** Spark returns only a flat list of source it actually inspected. Distill reads the exact ranges itself. */
export const contextManifestSchema = v.strictObject({
  files: v.pipe(v.array(contextFile), v.maxLength(40)),
  searchesCompleted: v.pipe(v.array(search), v.maxLength(20)),
  validation: v.pipe(v.array(text(1_000)), v.maxLength(20)),
});

export type ContextPriority = v.InferOutput<typeof priority>;
export type ContextExcerptRequest = v.InferOutput<typeof excerpt>;
export type ContextFile = v.InferOutput<typeof contextFile>;
export type ContextSearch = v.InferOutput<typeof search>;
export type ContextManifest = v.InferOutput<typeof contextManifestSchema>;
export const contextManifestJsonSchema = toJsonSchema(contextManifestSchema);

/** Codex structured outputs require every property to be required and every object to be closed. */
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

export function parseContextManifest(value: unknown): ContextManifest {
  const manifest = v.parse(contextManifestSchema, omitNulls(value));
  if (manifest.validation.some((command) => !executable(command))) throw new Error("Context validation contains a non-executable command.");
  return manifest;
}
