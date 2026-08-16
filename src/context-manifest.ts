import { toJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";

const priority = v.picklist([1, 2, 3]);
const source = v.strictObject({ path: v.string(), startLine: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))), endLine: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))) });
const range = v.strictObject({ startLine: v.pipe(v.number(), v.integer(), v.minValue(1)), endLine: v.pipe(v.number(), v.integer(), v.minValue(1)) });

export const contextManifestSchema = v.strictObject({
  summary: v.string(),
  notes: v.array(v.strictObject({
    kind: v.picklist(["rule", "requirement", "acceptance", "out_of_scope", "workstream", "finding", "risk"]),
    text: v.string(), source: v.optional(source), priority,
  })),
  files: v.array(v.strictObject({
    path: v.string(), role: v.picklist(["edit", "caller", "test", "documentation", "generated", "changed", "conflict"]),
    reason: v.string(), ranges: v.optional(v.array(range)), priority, includeExcerpt: v.boolean(),
  })),
  validation: v.array(v.string()),
  gaps: v.array(v.string()),
});

export type ContextManifest = v.InferOutput<typeof contextManifestSchema>;
export const contextManifestJsonSchema = toJsonSchema(contextManifestSchema);

/**
 * Codex structured output requires every object property to be required. Model
 * optionality is therefore represented as a required nullable property, then
 * normalized back to the Valibot manifest shape after parsing.
 */
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
  for (const [key, value] of Object.entries(result)) {
    if (key !== "properties" && key !== "required") result[key] = codexSchema(value);
  }
  return result;
}

export const codexContextManifestJsonSchema = codexSchema(contextManifestJsonSchema);

function omitNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitNulls);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, nested]) => nested !== null).map(([key, nested]) => [key, omitNulls(nested)]));
}

export function parseContextManifest(value: unknown): ContextManifest {
  return v.parse(contextManifestSchema, omitNulls(value));
}
