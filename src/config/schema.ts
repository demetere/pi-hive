import { Type, type Static, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import {
  createDiagnosticCollector,
  sourceRange,
  type DiagnosticResult,
  type SourceRange,
} from "./diagnostics";
import type { YamlSourceMap } from "./yaml";
import { SCHEMA_VERSION } from "./versions";

export const PUBLIC_ID_PATTERN = "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$";
export const DURATION_V1_PATTERN = "^[1-9][0-9]*(ms|s|m|h)$";
export const MODEL_REFERENCE_PATTERN = "^(?:inherit|[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)+)$";

const closed = { additionalProperties: false } as const;
const unique = { uniqueItems: true } as const;

function literals<const Values extends readonly [string, ...string[]]>(values: Values) {
  return Type.Union(values.map((value) => Type.Literal(value)));
}

export const NonEmptyStringSchema = Type.String({ pattern: "\\S" });
export const PublicIdSchema = Type.String({ pattern: PUBLIC_ID_PATTERN });
export const DurationV1Schema = Type.String({ pattern: DURATION_V1_PATTERN });
export const ModelReferenceSchema = Type.String({ pattern: MODEL_REFERENCE_PATTERN });
export const PositiveSafeIntegerSchema = Type.Integer({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
});

export const ThinkingLevelSchema = literals([
  "inherit", "off", "minimal", "low", "medium", "high", "xhigh",
]);
export const FilesystemOperationSchema = literals(["read", "create", "update", "delete"]);
export const ShellCapabilitySchema = literals([
  "inspect", "test", "build", "package", "mutate", "execute-code",
]);
export const ArtifactCapabilitySchema = literals(["read", "write", "review"]);
export const KnowledgeCapabilitySchema = literals(["read", "propose", "curate"]);
export const ArtifactBindingSchema = literals(["none", "new", "existing", "either"]);
export const CheckpointPolicySchema = literals(["required", "optional", "none"]);

const UniquePublicIdsSchema = Type.Array(PublicIdSchema, unique);
const UniqueNonEmptyStringsSchema = Type.Array(NonEmptyStringSchema, unique);

export const FilesystemGrantSchema = Type.Object({
  path: NonEmptyStringSchema,
  operations: Type.Array(FilesystemOperationSchema, { minItems: 1, uniqueItems: true }),
  include: Type.Optional(UniqueNonEmptyStringsSchema),
  exclude: Type.Optional(UniqueNonEmptyStringsSchema),
}, closed);

export const RawCapabilitiesSchema = Type.Object({
  filesystem: Type.Optional(Type.Array(FilesystemGrantSchema)),
  shell: Type.Optional(Type.Array(ShellCapabilitySchema, unique)),
  git: Type.Optional(Type.Boolean()),
  "external-network": Type.Optional(Type.Boolean()),
  "human-input": Type.Optional(Type.Boolean()),
  artifact: Type.Optional(Type.Array(ArtifactCapabilitySchema, unique)),
  knowledge: Type.Optional(Type.Array(KnowledgeCapabilitySchema, unique)),
}, closed);

export const RawAgentBudgetsSchema = Type.Object({
  "max-agent-turns": Type.Optional(PositiveSafeIntegerSchema),
  "max-tool-calls": Type.Optional(PositiveSafeIntegerSchema),
  "token-budget": Type.Optional(PositiveSafeIntegerSchema),
  "active-wall-time": Type.Optional(DurationV1Schema),
}, closed);

export const RawWorkflowBudgetsSchema = Type.Object({
  "max-parallel": Type.Optional(PositiveSafeIntegerSchema),
  "max-delegations": Type.Optional(PositiveSafeIntegerSchema),
  "max-agent-turns": Type.Optional(PositiveSafeIntegerSchema),
  "max-tool-calls": Type.Optional(PositiveSafeIntegerSchema),
  "token-budget": Type.Optional(PositiveSafeIntegerSchema),
  "active-wall-time": Type.Optional(DurationV1Schema),
}, closed);

const AgentDefaultsSchema = Type.Object({
  model: Type.Optional(ModelReferenceSchema),
  thinking: Type.Optional(ThinkingLevelSchema),
}, closed);

const WorkflowDefaultsSchema = Type.Object({
  budgets: Type.Optional(RawWorkflowBudgetsSchema),
}, closed);

const ManifestSettingsSchema = Type.Object({
  telemetry: Type.Optional(Type.Object({
    "dashboard-start": Type.Optional(literals(["session", "workflow", "manual"])),
  }, closed)),
  defaults: Type.Optional(Type.Object({
    agent: Type.Optional(AgentDefaultsSchema),
    workflow: Type.Optional(WorkflowDefaultsSchema),
  }, closed)),
}, closed);

const StringRegistrySchema = Type.Record(PublicIdSchema, NonEmptyStringSchema, closed);
const KnowledgeEntrySchema = Type.Object({
  provider: Type.Literal("okf"),
  path: NonEmptyStringSchema,
  owner: Type.Optional(PublicIdSchema),
  updates: Type.Optional(literals(["automatic", "reviewed", "read-only"])),
}, closed);
const KnowledgeRegistrySchema = Type.Record(PublicIdSchema, KnowledgeEntrySchema, closed);

export const ManifestV1Schema = Type.Object({
  "schema-version": Type.Literal(SCHEMA_VERSION),
  agents: StringRegistrySchema,
  workflows: StringRegistrySchema,
  settings: Type.Optional(ManifestSettingsSchema),
  skills: Type.Optional(StringRegistrySchema),
  knowledge: Type.Optional(KnowledgeRegistrySchema),
}, closed);

export const AgentFrontmatterV1Schema = Type.Object({
  name: NonEmptyStringSchema,
  capabilities: RawCapabilitiesSchema,
  description: Type.Optional(NonEmptyStringSchema),
  model: Type.Optional(ModelReferenceSchema),
  thinking: Type.Optional(ThinkingLevelSchema),
  tags: Type.Optional(UniquePublicIdsSchema),
  skills: Type.Optional(UniquePublicIdsSchema),
  knowledge: Type.Optional(UniquePublicIdsSchema),
  budgets: Type.Optional(RawAgentBudgetsSchema),
}, closed);

const AddRemoveIdsSchema = Type.Object({
  add: Type.Optional(UniquePublicIdsSchema),
  remove: Type.Optional(UniquePublicIdsSchema),
}, closed);

const TeamOverridesSchema = Type.Object({
  model: Type.Optional(ModelReferenceSchema),
  thinking: Type.Optional(ThinkingLevelSchema),
  capabilities: Type.Optional(RawCapabilitiesSchema),
  budgets: Type.Optional(RawAgentBudgetsSchema),
  skills: Type.Optional(AddRemoveIdsSchema),
  knowledge: Type.Optional(AddRemoveIdsSchema),
}, closed);

export const RawTeamNodeV1Schema = Type.Cyclic({
  RawTeamNodeV1: Type.Object({
    id: PublicIdSchema,
    agent: PublicIdSchema,
    role: Type.Optional(NonEmptyStringSchema),
    responsibilities: Type.Optional(UniqueNonEmptyStringsSchema),
    "consult-when": Type.Optional(NonEmptyStringSchema),
    overrides: Type.Optional(TeamOverridesSchema),
    members: Type.Optional(Type.Array(Type.Ref("RawTeamNodeV1"))),
  }, closed),
}, "RawTeamNodeV1");

export const JsonValueSchema = Type.Cyclic({
  JsonValue: Type.Union([
    Type.Null(),
    Type.Boolean(),
    Type.Number(),
    Type.String(),
    Type.Array(Type.Ref("JsonValue")),
    Type.Record(Type.String(), Type.Ref("JsonValue"), closed),
  ]),
}, "JsonValue");

const ArtifactSchema = Type.Object({
  adapter: PublicIdSchema,
  profile: PublicIdSchema,
  binding: ArtifactBindingSchema,
  options: Type.Optional(Type.Record(Type.String(), JsonValueSchema, closed)),
}, closed);

const InstructionsSchema = Type.Object({
  shared: Type.Optional(NonEmptyStringSchema),
  root: NonEmptyStringSchema,
}, closed);

export const WorkflowV1Schema = Type.Object({
  name: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  "use-when": NonEmptyStringSchema,
  artifact: ArtifactSchema,
  team: RawTeamNodeV1Schema,
  instructions: InstructionsSchema,
  "avoid-when": Type.Optional(NonEmptyStringSchema),
  tags: Type.Optional(UniquePublicIdsSchema),
  examples: Type.Optional(UniqueNonEmptyStringsSchema),
  "suggested-next": Type.Optional(UniquePublicIdsSchema),
  approvals: Type.Optional(Type.Record(PublicIdSchema, CheckpointPolicySchema, closed)),
  budgets: Type.Optional(RawWorkflowBudgetsSchema),
}, closed);

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function diagnosticRange(
  error: { keyword: string; instancePath: string; params: Record<string, unknown> },
  sourceMap: YamlSourceMap,
): SourceRange {
  const additional = error.params.additionalProperties;
  if (error.keyword === "additionalProperties" && Array.isArray(additional) && typeof additional[0] === "string") {
    const entry = sourceMap[`${error.instancePath}/${escapePointer(additional[0])}`];
    if (entry?.key) return entry.key;
  }
  return sourceMap[error.instancePath]?.value ?? sourceMap[""]?.value ?? sourceRange(0, 1, 1, 0, 1, 1);
}

export function validateSchemaValue<Schema extends TSchema>(
  schema: Schema,
  value: unknown,
  source: string,
  sourceMap: YamlSourceMap,
): DiagnosticResult<Static<Schema>> {
  const collector = createDiagnosticCollector();
  if (Check(schema, value)) return collector.result(value as Static<Schema>);

  for (const error of Errors(schema, value)) {
    collector.add({
      code: "SCHEMA_INVALID",
      severity: "error",
      message: `${error.instancePath || "/"} ${error.message}`,
      source,
      range: diagnosticRange(error, sourceMap),
    });
  }
  return collector.result();
}

export function validateManifestV1(
  value: unknown,
  source: string,
  sourceMap: YamlSourceMap,
): DiagnosticResult<Static<typeof ManifestV1Schema>> {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  if (!record || !("schema-version" in record)) {
    const collector = createDiagnosticCollector();
    collector.add({
      code: "SCHEMA_VERSION_MISSING",
      severity: "error",
      message: "Manifest schema-version is required; supported version: 1.",
      source,
      range: sourceMap[""]?.value ?? sourceRange(0, 1, 1, 0, 1, 1),
    });
    return collector.result();
  }
  if (record["schema-version"] !== SCHEMA_VERSION) {
    const collector = createDiagnosticCollector();
    collector.add({
      code: "SCHEMA_VERSION_UNSUPPORTED",
      severity: "error",
      message: `Manifest schema-version ${String(record["schema-version"])} is unsupported; supported version: 1.`,
      source,
      range: sourceMap["/schema-version"]?.value ?? sourceMap[""]?.value ?? sourceRange(0, 1, 1, 0, 1, 1),
    });
    return collector.result();
  }
  return validateSchemaValue(ManifestV1Schema, value, source, sourceMap);
}
