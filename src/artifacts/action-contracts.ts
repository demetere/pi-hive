import type { TSchema } from "typebox";
import type { JsonValue } from "../config/types";
import { boundedJson, plainRecord } from "../workflows/values";
import { ARTIFACT_CONTRACT_LIMITS } from "./contracts";

export interface ArtifactArgumentVariantV1 {
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

export interface ProviderArtifactArgumentContractV1 {
  readonly argumentsSchemaVersion: "1";
  readonly argumentsSchema: Readonly<Record<string, JsonValue>>;
  readonly required: readonly string[];
  readonly optional: readonly string[];
  readonly variants: readonly ArtifactArgumentVariantV1[];
}

const SCHEMA_KEYS = new Set([
  "type", "const", "enum", "pattern", "minLength", "maxLength", "minimum", "maximum",
  "minItems", "maxItems", "uniqueItems", "properties", "required", "additionalProperties",
  "items", "anyOf", "oneOf", "allOf",
]);
const SCHEMA_TYPES = new Set(["object", "array", "string", "integer", "number", "boolean", "null"]);

interface SanitizeState { nodes: number }

function schemaName(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)
    || Buffer.byteLength(value, "utf8") > ARTIFACT_CONTRACT_LIMITS.idBytes) throw new Error("Artifact argument schema field name is invalid");
  return value;
}

function scalar(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && Buffer.byteLength(value, "utf8") <= ARTIFACT_CONTRACT_LIMITS.argumentSchemaStringBytes) return value;
  throw new Error("Artifact argument schema scalar is invalid or exceeds its bound");
}

function sanitizeSchema(value: unknown, state: SanitizeState, depth = 0): Record<string, JsonValue> {
  if (!plainRecord(value) || depth > ARTIFACT_CONTRACT_LIMITS.argumentSchemaDepth || ++state.nodes > ARTIFACT_CONTRACT_LIMITS.argumentSchemaNodes) {
    throw new Error("Artifact argument schema is invalid or exceeds its structural bound");
  }
  const result: Record<string, JsonValue> = {};
  for (const [key, raw] of Object.entries(value)) {
    // Descriptions, examples, defaults, comments, references, custom keywords,
    // and adapter metadata are deliberately not provider-visible.
    if (!SCHEMA_KEYS.has(key)) continue;
    if (key === "type") {
      if (typeof raw !== "string" || !SCHEMA_TYPES.has(raw)) throw new Error("Artifact argument schema type is invalid");
      result[key] = raw;
    } else if (key === "const") result[key] = scalar(raw);
    else if (key === "enum") {
      if (!Array.isArray(raw) || raw.length > ARTIFACT_CONTRACT_LIMITS.argumentSchemaItems) throw new Error("Artifact argument schema enum exceeds its bound");
      result[key] = raw.map(scalar);
    } else if (key === "pattern") {
      if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > ARTIFACT_CONTRACT_LIMITS.argumentSchemaStringBytes) throw new Error("Artifact argument schema pattern exceeds its bound");
      result[key] = raw;
    } else if (["minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems"].includes(key)) {
      if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) throw new Error(`Artifact argument schema ${key} is invalid`);
      result[key] = raw;
    } else if (key === "uniqueItems" || key === "additionalProperties") {
      if (typeof raw !== "boolean") throw new Error(`Artifact argument schema ${key} is invalid`);
      result[key] = raw;
    } else if (key === "required") {
      if (!Array.isArray(raw) || raw.length > ARTIFACT_CONTRACT_LIMITS.argumentSchemaProperties) throw new Error("Artifact argument schema required fields exceed their bound");
      const names = raw.map(schemaName);
      if (new Set(names).size !== names.length) throw new Error("Artifact argument schema required fields are duplicated");
      result[key] = names;
    } else if (key === "properties") {
      if (!plainRecord(raw) || Object.keys(raw).length > ARTIFACT_CONTRACT_LIMITS.argumentSchemaProperties) throw new Error("Artifact argument schema properties exceed their bound");
      result[key] = Object.fromEntries(Object.entries(raw).map(([name, child]) => [schemaName(name), sanitizeSchema(child, state, depth + 1)])) as JsonValue;
    } else if (key === "items") result[key] = sanitizeSchema(raw, state, depth + 1) as JsonValue;
    else {
      if (!Array.isArray(raw) || raw.length < 1 || raw.length > ARTIFACT_CONTRACT_LIMITS.argumentSchemaVariants) throw new Error(`Artifact argument schema ${key} variants exceed their bound`);
      result[key] = raw.map((child) => sanitizeSchema(child, state, depth + 1)) as JsonValue;
    }
  }
  return result;
}

function variant(schema: Record<string, JsonValue>): ArtifactArgumentVariantV1 {
  const properties = plainRecord(schema.properties) ? Object.keys(schema.properties) : [];
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  const requiredSet = new Set(required);
  return Object.freeze({
    required: Object.freeze(required),
    optional: Object.freeze(properties.filter((name) => !requiredSet.has(name))),
  });
}

export function providerArtifactArgumentContract(schemaVersion: "1", rawSchema: TSchema | Readonly<Record<string, unknown>>): ProviderArtifactArgumentContractV1 {
  const argumentsSchema = sanitizeSchema(rawSchema, { nodes: 0 });
  const alternatives = Array.isArray(argumentsSchema.anyOf)
    ? argumentsSchema.anyOf
    : Array.isArray(argumentsSchema.oneOf) ? argumentsSchema.oneOf : [argumentsSchema];
  const variants = alternatives.map((entry) => variant(entry as Record<string, JsonValue>));
  if (variants.length > ARTIFACT_CONTRACT_LIMITS.argumentSchemaVariants) throw new Error("Artifact argument contract variants exceed their bound");
  const required = variants.length
    ? variants[0].required.filter((name) => variants.every((entry) => entry.required.includes(name)))
    : [];
  const fields = [...new Set(variants.flatMap((entry) => [...entry.required, ...entry.optional]))];
  const requiredSet = new Set(required);
  const contract: ProviderArtifactArgumentContractV1 = Object.freeze({
    argumentsSchemaVersion: schemaVersion,
    argumentsSchema: Object.freeze(argumentsSchema),
    required: Object.freeze(required),
    optional: Object.freeze(fields.filter((name) => !requiredSet.has(name))),
    variants: Object.freeze(variants),
  });
  boundedJson(contract, "Provider artifact argument contract", {
    bytes: ARTIFACT_CONTRACT_LIMITS.argumentSchemaBytes,
    depth: ARTIFACT_CONTRACT_LIMITS.argumentSchemaDepth,
    nodes: ARTIFACT_CONTRACT_LIMITS.argumentSchemaNodes,
  });
  return contract;
}
