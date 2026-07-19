import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ActivationSnapshotFileV1 } from "../config/snapshot";
import { canonicalJson } from "../config/snapshot-canonical";
import { classifyTrustedTool, classifyTrustedToolRegistration } from "../capabilities/tools";
import type { BudgetState } from "./budgets";
import type { DelegationState, DelegationStatusPage } from "./delegation";
import type { RunLifecycleState } from "./runs";
import type { HandoffPacket } from "./handoff";
import type { WorkerTrustedDispatch } from "./workers";
import { boundedJson } from "./values";
import { QUESTION_LIMITS, normalizeQuestionDefinition } from "./question-validation";

export const TOOL_CONTRACT_VERSION = "pi-hive-prompt-tool-contract-v1" as const;
export const TOOL_CONTRACT_LIMITS = Object.freeze({
  objectiveCharacters: 32_768,
  objectiveBytes: 32_768,
  idCharacters: 256,
  idBytes: 256,
  deliverables: 32,
  deliverableCharacters: 2_048,
  deliverableBytes: 2_048,
  references: 32,
  referenceKindCharacters: 128,
  referenceIdCharacters: 2_048,
  pageSize: 40,
  cursorCharacters: 512,
  outputBytes: 65_536,
  previewBytes: 1_024,
  toolBatch: 64,
});

const strict = { additionalProperties: false } as const;
const Id = Type.String({ minLength: 1, maxLength: TOOL_CONTRACT_LIMITS.idCharacters });
const Reference = Type.Object({
  kind: Type.String({ minLength: 1, maxLength: TOOL_CONTRACT_LIMITS.referenceKindCharacters }),
  id: Type.String({ minLength: 1, maxLength: TOOL_CONTRACT_LIMITS.referenceIdCharacters }),
}, strict);
const RequiredCapabilities = Type.Object({
  filesystem: Type.Optional(Type.Boolean()),
  shell: Type.Optional(Type.Array(Type.Union([Type.Literal("inspect"), Type.Literal("test"), Type.Literal("build"), Type.Literal("package"), Type.Literal("mutate"), Type.Literal("execute-code")]), { maxItems: 6, uniqueItems: true })),
  git: Type.Optional(Type.Boolean()),
  externalNetwork: Type.Optional(Type.Boolean()),
  humanInput: Type.Optional(Type.Boolean()),
  artifact: Type.Optional(Type.Array(Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("review")]), { maxItems: 3, uniqueItems: true })),
  knowledge: Type.Optional(Type.Array(Type.Union([Type.Literal("read"), Type.Literal("propose"), Type.Literal("curate")]), { maxItems: 3, uniqueItems: true })),
}, strict);
const CursorPage = {
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: TOOL_CONTRACT_LIMITS.pageSize })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: TOOL_CONTRACT_LIMITS.cursorCharacters, pattern: "^[0-9]+$" })),
};
const ArtifactReference = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 2_048 }),
  checkpoint: Type.String({ minLength: 1, maxLength: 2_048 }),
  digest: Type.String({ pattern: "^sha256:[0-9a-f]{64}$", maxLength: 71 }),
}, strict);
const EvidenceReference = Type.Object({
  kind: Type.String({ minLength: 1, maxLength: 2_048 }),
  toolCallId: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048 })),
  claim: Type.String({ minLength: 1, maxLength: 2_048 }),
}, strict);
const SAFE_QUESTION_TEXT_PATTERN = "^[^\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]*$";
const QuestionChoice = Type.Object({
  value: Type.String({ minLength: 1, maxLength: QUESTION_LIMITS.choiceValueBytes, pattern: SAFE_QUESTION_TEXT_PATTERN }),
  label: Type.String({ minLength: 1, maxLength: QUESTION_LIMITS.choiceLabelBytes, pattern: SAFE_QUESTION_TEXT_PATTERN }),
}, strict);
const QuestionTextValidation = Type.Object({
  minLength: Type.Optional(Type.Integer({ minimum: 0, maximum: QUESTION_LIMITS.textAnswerBytes })),
  maxLength: Type.Optional(Type.Integer({ minimum: 0, maximum: QUESTION_LIMITS.textAnswerBytes })),
  pattern: Type.Optional(Type.String({ minLength: 1, maxLength: QUESTION_LIMITS.patternBytes })),
}, strict);
const QuestionMultiValidation = Type.Object({
  minItems: Type.Optional(Type.Integer({ minimum: 0, maximum: QUESTION_LIMITS.choices })),
  maxItems: Type.Optional(Type.Integer({ minimum: 0, maximum: QUESTION_LIMITS.choices })),
}, strict);
const QuestionPrompt = Type.String({ minLength: 1, maxLength: QUESTION_LIMITS.promptBytes, pattern: SAFE_QUESTION_TEXT_PATTERN });

export const GENERIC_WORKFLOW_TOOL_SCHEMAS = Object.freeze({
  route_agent: Type.Object({
    objective: Type.String({ minLength: 1, maxLength: TOOL_CONTRACT_LIMITS.objectiveCharacters }),
    requiredCapabilities: Type.Optional(RequiredCapabilities),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: TOOL_CONTRACT_LIMITS.pageSize })),
    includeUnmatched: Type.Optional(Type.Boolean()),
  }, strict),
  delegate_agent: Type.Object({
    targetNodeId: Id,
    objective: Type.String({ minLength: 1, maxLength: TOOL_CONTRACT_LIMITS.objectiveCharacters }),
    contextRefs: Type.Optional(Type.Array(Reference, { maxItems: TOOL_CONTRACT_LIMITS.references })),
    deliverables: Type.Array(Type.String({ minLength: 1, maxLength: TOOL_CONTRACT_LIMITS.deliverableCharacters }), { maxItems: TOOL_CONTRACT_LIMITS.deliverables }),
  }, strict),
  team_status: Type.Union([
    Type.Object(CursorPage, strict),
    Type.Object({
      action: Type.Literal("deliver-results"),
      deliveryId: Id,
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: TOOL_CONTRACT_LIMITS.pageSize })),
    }, strict),
  ]),
  workflow_status: Type.Object({
    section: Type.Optional(Type.Union([Type.Literal("summary"), Type.Literal("inputs"), Type.Literal("handoff"), Type.Literal("file-changes"), Type.Literal("artifact-refs"), Type.Literal("evidence-refs")])),
    packetHash: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$", maxLength: 64 })),
    ...CursorPage,
  }, strict),
  artifact_status: Type.Object(CursorPage, strict),
  artifact_action: Type.Object({
    actionId: Id,
    arguments: Type.Record(Type.String({ minLength: 1, maxLength: TOOL_CONTRACT_LIMITS.idCharacters }), Type.Unknown()),
    expectedWorkspaceHash: Type.Optional(Type.String({ pattern: "^sha256:[0-9a-f]{64}$", maxLength: 71 })),
  }, strict),
  human_question: Type.Union([
    Type.Object({ prompt: QuestionPrompt, kind: Type.Literal("single"), choices: Type.Array(QuestionChoice, { minItems: 1, maxItems: QUESTION_LIMITS.choices }), required: Type.Boolean() }, strict),
    Type.Object({ prompt: QuestionPrompt, kind: Type.Literal("multi"), choices: Type.Array(QuestionChoice, { minItems: 1, maxItems: QUESTION_LIMITS.choices }), validation: Type.Optional(QuestionMultiValidation), required: Type.Boolean() }, strict),
    Type.Object({ prompt: QuestionPrompt, kind: Type.Literal("text"), validation: Type.Optional(QuestionTextValidation), required: Type.Boolean() }, strict),
    Type.Object({ prompt: QuestionPrompt, kind: Type.Literal("confirm"), required: Type.Boolean() }, strict),
  ]),
  workflow_finish: Type.Object({
    status: Type.Union([Type.Literal("completed"), Type.Literal("blocked"), Type.Literal("failed")]),
    summary: Type.String({ minLength: 1, maxLength: 8_192 }),
    artifactRefs: Type.Optional(Type.Array(ArtifactReference, { maxItems: 128 })),
    evidenceRefs: Type.Optional(Type.Array(EvidenceReference, { maxItems: 128 })),
    data: Type.Optional(Type.Unknown()),
  }, strict),
});

export type GenericWorkflowToolName = keyof typeof GENERIC_WORKFLOW_TOOL_SCHEMAS;
export interface WorkflowStatusRequest { readonly section?: "summary" | "inputs" | "handoff" | "file-changes" | "artifact-refs" | "evidence-refs"; readonly packetHash?: string; readonly limit?: number; readonly cursor?: string }
export interface WorkflowStatusPage { readonly section: string; readonly total: number; readonly items: readonly unknown[]; readonly nextCursor?: string; readonly summary?: Readonly<Record<string, unknown>> }

interface TeamRuntime {
  route(input: { objective: string; requiredCapabilities?: Record<string, unknown>; limit?: number; includeUnmatched?: boolean }): unknown;
  delegate(input: { targetNodeId: string; objective: string; contextRefs?: readonly { kind: string; id: string }[]; deliverables: readonly string[] }): unknown;
  status(options?: { limit?: number; cursor?: string }): DelegationStatusPage;
  deliverResults(deliveryId: string, options?: { limit?: number }): unknown;
}
export interface WorkflowToolRuntimeBindingInput {
  readonly snapshot: ActivationSnapshotFileV1;
  readonly nodeId: string;
  readonly dispatch: WorkerTrustedDispatch;
  readonly team: TeamRuntime;
  readonly workflowStatus: (input: WorkflowStatusRequest) => WorkflowStatusPage;
  readonly artifactStatus?: (input: { readonly limit?: number; readonly cursor?: string }, signal?: AbortSignal) => Promise<unknown>;
  readonly artifactAction?: (input: { readonly actionId: string; readonly arguments: Readonly<Record<string, unknown>>; readonly expectedWorkspaceHash?: string }, attemptId: string, signal?: AbortSignal) => Promise<unknown>;
  readonly question?: (input: unknown, toolCallId: string, signal?: AbortSignal, batchCallIds?: readonly string[]) => Promise<unknown>;
  readonly finish: (input: unknown, toolBatch: readonly string[]) => Promise<unknown>;
}
export interface WorkflowToolRuntimeBinding {
  readonly schemaVersion: 1;
  readonly snapshot: ActivationSnapshotFileV1;
  readonly nodeId: string;
  readonly dispatch: WorkerTrustedDispatch;
  readonly team: TeamRuntime;
  readonly workflowStatus: WorkflowToolRuntimeBindingInput["workflowStatus"];
  readonly artifactStatus?: WorkflowToolRuntimeBindingInput["artifactStatus"];
  readonly artifactAction?: WorkflowToolRuntimeBindingInput["artifactAction"];
  readonly question?: WorkflowToolRuntimeBindingInput["question"];
  readonly finish: WorkflowToolRuntimeBindingInput["finish"];
}
interface ActiveWorkflowToolRuntime { readonly binding: WorkflowToolRuntimeBinding }
const ISSUED_BINDINGS = new WeakSet<object>();
const TOOL_RUNTIME = new AsyncLocalStorage<ActiveWorkflowToolRuntime>();

export function issueWorkflowToolRuntimeBinding(input: WorkflowToolRuntimeBindingInput): WorkflowToolRuntimeBinding {
  if (!input.snapshot.payload.authority.nodes.some((node) => node.nodeId === input.nodeId)) throw new Error("Workflow tool runtime node is absent from immutable authority");
  if (input.dispatch?.schemaVersion !== 1) throw new Error("Workflow tool runtime requires trusted W13 dispatch");
  const binding = Object.freeze({ schemaVersion: 1 as const, ...input });
  ISSUED_BINDINGS.add(binding);
  return binding;
}

export function runWithWorkflowToolRuntime<T>(binding: WorkflowToolRuntimeBinding, callback: () => T): T {
  if (!ISSUED_BINDINGS.has(binding as object)) throw new Error("A trusted workflow tool runtime binding is required");
  if (typeof callback !== "function") throw new Error("A workflow tool runtime callback is required");
  return TOOL_RUNTIME.run({ binding }, callback);
}

function currentRuntime(): ActiveWorkflowToolRuntime {
  const runtime = TOOL_RUNTIME.getStore();
  if (!runtime || !ISSUED_BINDINGS.has(runtime.binding as object)) throw new Error("Generic tools require a trusted workflow tool runtime");
  return runtime;
}
function utf8Prefix(value: string, bytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= bytes) return value;
  let output = "";
  let used = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > bytes) break;
    output += character;
    used += size;
  }
  return output;
}
function assertUtf8(value: unknown, label: string, bytes: number): void {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > bytes) throw new Error(`${label} is invalid or exceeds its UTF-8 byte limit`);
}
function assertByteBounds(name: GenericWorkflowToolName, input: Record<string, unknown>): void {
  if (name === "route_agent" || name === "delegate_agent") assertUtf8(input.objective, `${name} objective`, TOOL_CONTRACT_LIMITS.objectiveBytes);
  if (name === "delegate_agent") {
    assertUtf8(input.targetNodeId, "delegate_agent targetNodeId", TOOL_CONTRACT_LIMITS.idBytes);
    for (const [index, value] of ((input.deliverables ?? []) as unknown[]).entries()) assertUtf8(value, `delegate_agent deliverable ${index}`, TOOL_CONTRACT_LIMITS.deliverableBytes);
    for (const [index, raw] of ((input.contextRefs ?? []) as Array<Record<string, unknown>>).entries()) {
      assertUtf8(raw.kind, `delegate_agent contextRefs[${index}].kind`, TOOL_CONTRACT_LIMITS.referenceKindCharacters);
      assertUtf8(raw.id, `delegate_agent contextRefs[${index}].id`, TOOL_CONTRACT_LIMITS.referenceIdCharacters);
    }
  }
  if (name === "team_status" && input.action === "deliver-results") assertUtf8(input.deliveryId, "team_status deliveryId", TOOL_CONTRACT_LIMITS.idBytes);
  if (name === "artifact_action") {
    assertUtf8(input.actionId, "artifact_action actionId", TOOL_CONTRACT_LIMITS.idBytes);
    boundedJson(input.arguments, "artifact_action arguments", { bytes: 65_536, depth: 16, nodes: 4_096, rootRecord: true });
    if (input.expectedWorkspaceHash !== undefined) assertUtf8(input.expectedWorkspaceHash, "artifact_action expectedWorkspaceHash", 71);
  }
  if (name === "human_question") normalizeQuestionDefinition(input);
  if (name === "workflow_finish") {
    assertUtf8(input.summary, "workflow_finish summary", 8_192);
    for (const [index, raw] of ((input.artifactRefs ?? []) as Array<Record<string, unknown>>).entries()) {
      assertUtf8(raw.workspaceId, `workflow_finish artifactRefs[${index}].workspaceId`, 2_048);
      assertUtf8(raw.checkpoint, `workflow_finish artifactRefs[${index}].checkpoint`, 2_048);
      assertUtf8(raw.digest, `workflow_finish artifactRefs[${index}].digest`, 71);
    }
    for (const [index, raw] of ((input.evidenceRefs ?? []) as Array<Record<string, unknown>>).entries()) {
      assertUtf8(raw.kind, `workflow_finish evidenceRefs[${index}].kind`, 2_048);
      if (raw.toolCallId !== undefined) assertUtf8(raw.toolCallId, `workflow_finish evidenceRefs[${index}].toolCallId`, 2_048);
      assertUtf8(raw.claim, `workflow_finish evidenceRefs[${index}].claim`, 2_048);
    }
    if (input.data !== undefined) {
      boundedJson(input.data, "workflow_finish data", { bytes: 65_536, depth: 16, nodes: 4_096, rootRecord: true });
      const pending: unknown[] = [input.data];
      while (pending.length) {
        const value = pending.pop();
        if (typeof value === "string") assertUtf8(value, "workflow_finish data string", 8_192);
        else if (Array.isArray(value)) pending.push(...value);
        else if (value && typeof value === "object") {
          for (const [key, child] of Object.entries(value)) {
            assertUtf8(key, "workflow_finish data key", 2_048);
            pending.push(child);
          }
        }
      }
    }
  }
}
function correlationId(toolCallId: string, name: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(toolCallId)) return toolCallId;
  return `tool-${name}-${createHash("sha256").update(toolCallId).digest("hex").slice(0, 32)}`;
}
function authorityTools(binding: WorkflowToolRuntimeBinding): readonly string[] {
  const authority = binding.snapshot.payload.authority.nodes.find((entry) => entry.nodeId === binding.nodeId);
  return Array.isArray(authority?.tools) ? authority.tools : [];
}
function resultDeliveryView(delivery: unknown): Readonly<Record<string, unknown>> {
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) throw new Error("Authorized result delivery is invalid");
  const raw = delivery as { deliveryId?: unknown; recipientNodeId?: unknown; items?: unknown };
  assertUtf8(raw.deliveryId, "Result delivery ID", TOOL_CONTRACT_LIMITS.idBytes);
  assertUtf8(raw.recipientNodeId, "Result recipient node ID", TOOL_CONTRACT_LIMITS.idBytes);
  if (!Array.isArray(raw.items) || raw.items.length > 20) throw new Error("Authorized result delivery page exceeds its bound");
  const items = raw.items.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Authorized result delivery item ${index} is invalid`);
    const item = entry as { taskId?: unknown; result?: unknown };
    assertUtf8(item.taskId, `Authorized result delivery task ${index}`, TOOL_CONTRACT_LIMITS.idBytes);
    if (!item.result || typeof item.result !== "object" || Array.isArray(item.result)) throw new Error(`Authorized result delivery result ${index} is invalid`);
    const result = item.result as Record<string, unknown>;
    assertUtf8(result.summary, `Authorized result delivery summary ${index}`, 8_192);
    const summary = utf8Prefix(String(result.summary), TOOL_CONTRACT_LIMITS.previewBytes);
    const canonical = canonicalJson(result);
    return Object.freeze({
      taskId: item.taskId,
      status: result.status,
      summary,
      summaryHash: hashText(String(result.summary)),
      summaryTruncated: summary !== result.summary,
      resultHash: hashText(canonical),
      outputRefCount: Array.isArray(result.outputRefs) ? result.outputRefs.length : 0,
      evidenceRefCount: Array.isArray(result.evidenceRefs) ? result.evidenceRefs.length : 0,
      dataBytes: Buffer.byteLength(canonicalJson(result.data ?? {}), "utf8"),
      readRef: `delivery:${String(raw.deliveryId)}/task:${String(item.taskId)}/result`,
    });
  });
  return Object.freeze({ deliveryId: raw.deliveryId, recipientNodeId: raw.recipientNodeId, accepted: true, items: Object.freeze(items) });
}

function boundedResult(value: unknown): { content: Array<{ type: "text"; text: string }>; details: object } {
  const text = canonicalJson(value);
  if (Buffer.byteLength(text, "utf8") > TOOL_CONTRACT_LIMITS.outputBytes) throw new Error("Generic tool result exceeds its bounded output contract; request a smaller page");
  return { content: [{ type: "text", text }], details: value && typeof value === "object" ? value as object : { value } };
}
function schemaInput(name: GenericWorkflowToolName, value: unknown): Record<string, unknown> {
  const schema = GENERIC_WORKFLOW_TOOL_SCHEMAS[name];
  if (!Value.Check(schema, value) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} parameters failed the exact strict schema`);
  const input = value as Record<string, unknown>;
  assertByteBounds(name, input);
  return input;
}

interface AssistantToolBatch {
  readonly names: readonly string[];
  readonly callIds: readonly string[];
}
function assistantToolBatch(ctx: ExtensionContext, toolCallId: string): AssistantToolBatch {
  const manager = ctx?.sessionManager;
  if (!manager || typeof manager.getBranch !== "function") throw new Error("Trusted Pi session context is required for workflow tools");
  const matches: AssistantToolBatch[] = [];
  for (const entry of manager.getBranch()) {
    if (!entry || entry.type !== "message" || !entry.message || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
    const calls = entry.message.content.filter((part) => Boolean(part) && typeof part === "object" && !Array.isArray(part) && (part as { type?: unknown }).type === "toolCall") as Array<{ id?: unknown; toolCallId?: unknown; name?: unknown; toolName?: unknown }>;
    if (!calls.some((part) => part.id === toolCallId || part.toolCallId === toolCallId)) continue;
    const names = calls.map((part) => part.name ?? part.toolName);
    const identifierKey = calls.some((part) => part.id === toolCallId) ? "id" : "toolCallId";
    const callIds = calls.map((part) => part[identifierKey]);
    if (!names.length || names.some((value) => typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > 128)
      || callIds.some((value) => typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > TOOL_CONTRACT_LIMITS.idBytes)
      || new Set(callIds).size !== callIds.length) throw new Error("Trusted Pi assistant tool-call batch is invalid");
    matches.push(Object.freeze({ names: Object.freeze(names as string[]), callIds: Object.freeze(callIds as string[]) }));
  }
  if (matches.length !== 1 || matches[0].names.length > TOOL_CONTRACT_LIMITS.toolBatch) throw new Error("Workflow tool call is not bound to one trusted Pi assistant tool-call batch");
  return matches[0];
}

async function executeTool(name: GenericWorkflowToolName, toolCallId: string, raw: unknown, ctx: ExtensionContext, signal?: AbortSignal): Promise<{ content: Array<{ type: "text"; text: string }>; details: object }> {
  const runtime = currentRuntime();
  const toolBatch = assistantToolBatch(ctx, toolCallId);
  if (toolBatch.names.includes("delegate_agent") && toolBatch.names.includes("human_question")) {
    // Both calls observe the complete immutable assistant batch before either
    // reaches trusted dispatch, so sequential and concurrent execution orders
    // reject without publishing a child task or a durable question.
    throw new Error("delegate_agent and human_question cannot be sibling calls in one assistant tool batch");
  }
  const input = schemaInput(name, raw);
  const descriptor = classifyTrustedTool(name);
  if (!descriptor || classifyTrustedToolRegistration(name, descriptor) !== descriptor) throw new Error(`Tool ${name} lacks trusted package registration identity`);
  const enabled = authorityTools(runtime.binding).includes(name);
  const soleFinish = name !== "workflow_finish" || (toolBatch.names.length === 1 && toolBatch.names[0] === "workflow_finish");
  const team = runtime.binding.snapshot.payload.workflow.team as { nodes?: unknown[] } | undefined;
  const callerNode = Array.isArray(team?.nodes)
    ? team.nodes.find((entry) => entry && typeof entry === "object" && !Array.isArray(entry) && (entry as { id?: unknown }).id === runtime.binding.nodeId) as { memberIds?: unknown } | undefined
    : undefined;
  const directTarget = name !== "delegate_agent" || (Array.isArray(callerNode?.memberIds) && callerNode.memberIds.includes(input.targetNodeId));
  const allowed = enabled && soleFinish && directTarget;
  const denialReason = !enabled
    ? `Policy denied ${name}: tool is not enabled for trusted node ${runtime.binding.nodeId}`
    : !directTarget
      ? `Policy denied delegate_agent: ${String(input.targetNodeId)} is not a direct member of ${runtime.binding.nodeId}`
      : `Policy denied workflow_finish: it must be the sole call in its tool batch`;
  const result = await runtime.binding.dispatch.tool({
    correlationId: correlationId(toolCallId, name),
    toolName: name,
    operation: `workflow.tool.${name}`,
    input,
    policyOutcome: allowed ? "allowed" : "denied",
    ...(allowed ? {} : { denialReason }),
    ...(name === "workflow_finish" && allowed ? { finalization: true } : {}),
    ...(name === "human_question" ? { questionBatchCallIds: toolBatch.callIds, questionBatchCurrentCallId: toolCallId } : {}),
    dispatch: async (attemptContext) => {
      if (name === "route_agent") return runtime.binding.team.route(input as never);
      if (name === "delegate_agent") return runtime.binding.team.delegate(input as never);
      if (name === "team_status") {
        if (input.action === "deliver-results") {
          const delivery = runtime.binding.team.deliverResults(String(input.deliveryId), { limit: Math.min(20, input.limit === undefined ? 20 : Number(input.limit)) });
          return resultDeliveryView(delivery);
        }
        return runtime.binding.team.status(input as { limit?: number; cursor?: string });
      }
      if (name === "workflow_status") return runtime.binding.workflowStatus(input as WorkflowStatusRequest);
      if (name === "artifact_status") {
        if (!runtime.binding.artifactStatus) throw Object.assign(new Error("Artifact status subsystem is not bound for this run"), { effectNotApplied: true });
        return runtime.binding.artifactStatus(input as { limit?: number; cursor?: string }, signal);
      }
      if (name === "artifact_action") {
        if (!runtime.binding.artifactAction) throw Object.assign(new Error("Artifact action subsystem is not bound for this run"), { effectNotApplied: true });
        return runtime.binding.artifactAction(input as { actionId: string; arguments: Readonly<Record<string, unknown>>; expectedWorkspaceHash?: string }, attemptContext.attemptId, signal);
      }
      if (name === "human_question") {
        if (!runtime.binding.question) throw Object.assign(new Error("Human question subsystem is not bound for this run"), { effectNotApplied: true });
        return runtime.binding.question(input, toolCallId, signal, toolBatch.callIds);
      }
      return runtime.binding.finish(input, toolBatch.names);
    },
  });
  if (name === "workflow_finish" && result && typeof result === "object" && "ok" in result && (result as { ok: boolean }).ok === false) {
    const finishFailure = result as unknown as { issues?: unknown };
    const issues = Array.isArray(finishFailure.issues) ? finishFailure.issues.map(String).join("; ") : "workflow finish rejected";
    throw new Error(utf8Prefix(issues, 8_192));
  }
  if (name === "workflow_finish" && result && typeof result === "object" && "envelope" in result) {
    const finish = result as { ok: boolean; envelope: { status: string; summary: string; finishedByNodeId: string; finishedAt: string; snapshotId: string; runId: string; terminalEventHash: string; fileChanges?: unknown[]; artifactRefs?: unknown[]; evidenceRefs?: unknown[] } };
    return boundedResult({
      ok: finish.ok,
      status: finish.envelope.status,
      summary: finish.envelope.summary,
      finishedByNodeId: finish.envelope.finishedByNodeId,
      finishedAt: finish.envelope.finishedAt,
      snapshotId: finish.envelope.snapshotId,
      runId: finish.envelope.runId,
      terminalEventHash: finish.envelope.terminalEventHash,
      readback: {
        fileChanges: { tool: "workflow_status", section: "file-changes", count: finish.envelope.fileChanges?.length ?? 0 },
        artifactRefs: { tool: "workflow_status", section: "artifact-refs", count: finish.envelope.artifactRefs?.length ?? 0 },
        evidenceRefs: { tool: "workflow_status", section: "evidence-refs", count: finish.envelope.evidenceRefs?.length ?? 0 },
      },
    });
  }
  return boundedResult(result);
}

function contract<N extends GenericWorkflowToolName>(name: N, label: string, description: string): ToolDefinition<(typeof GENERIC_WORKFLOW_TOOL_SCHEMAS)[N], object> {
  return {
    name,
    label,
    description,
    parameters: GENERIC_WORKFLOW_TOOL_SCHEMAS[name],
    async execute(toolCallId: string, input: unknown, signal, _onUpdate, ctx) { return executeTool(name, toolCallId, input, ctx, signal); },
  };
}

// These runtime-independent contracts keep schemas and handlers usable on all
// supported Node versions. The Pi defineTool adapter lives under integration/.
export const GENERIC_WORKFLOW_TOOL_CONTRACTS: readonly ToolDefinition<any, object>[] = Object.freeze([
  contract("route_agent", "Route Agent", "Deterministically rank this caller's direct members by declared metadata and required capabilities; starts no work."),
  contract("delegate_agent", "Delegate Agent", "Persist and queue one bounded task for one exact direct member."),
  contract("team_status", "Team Status", "Read a bounded cursor-paginated view of task and direct-team runtime state."),
  contract("workflow_status", "Workflow Status", "Read bounded cursor-paginated workflow/run status and authority-derived terminal refs."),
  contract("artifact_status", "Artifact Status", "Read the active profile's bounded trusted workspace/checkpoint/action view."),
  contract("artifact_action", "Artifact Action", "Invoke one exact active-profile action; workspace and operation identity come only from trusted run state."),
  contract("human_question", "Human Question", "Persist one bounded typed human question. Pending questions suspend the current task rather than blocking an in-memory promise."),
  contract("workflow_finish", "Workflow Finish", "Root-only sole-call request for a validated terminal workflow outcome."),
]);

export function genericWorkflowToolContractsForNode(snapshot: ActivationSnapshotFileV1, nodeId: string): readonly ToolDefinition<any, object>[] {
  const authority = snapshot.payload.authority.nodes.find((entry) => entry.nodeId === nodeId);
  if (!authority || !Array.isArray(authority.tools)) throw new Error(`Generic tool node ${nodeId} is absent from immutable authority`);
  const enabled = new Set(authority.tools);
  return Object.freeze(GENERIC_WORKFLOW_TOOL_CONTRACTS.filter((tool) => enabled.has(tool.name)));
}

function pageOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^[0-9]+$/u.test(cursor) || Buffer.byteLength(cursor, "utf8") > TOOL_CONTRACT_LIMITS.cursorCharacters) throw new Error("Workflow status cursor is invalid");
  const value = Number(cursor);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Workflow status cursor is invalid");
  return value;
}
function hashText(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function paginate(section: string, all: readonly unknown[], request: WorkflowStatusRequest, summary?: Readonly<Record<string, unknown>>): WorkflowStatusPage {
  const offset = pageOffset(request.cursor);
  const limit = Number.isSafeInteger(request.limit) && Number(request.limit) > 0 ? Math.min(TOOL_CONTRACT_LIMITS.pageSize, Number(request.limit)) : 20;
  const items = all.slice(offset, offset + limit);
  return Object.freeze({ section, total: all.length, items: Object.freeze(items), ...(offset + items.length < all.length ? { nextCursor: String(offset + items.length) } : {}), ...(summary ? { summary } : {}) });
}

export function buildWorkflowStatusPage(input: {
  readonly snapshot: ActivationSnapshotFileV1;
  readonly lifecycle: RunLifecycleState;
  readonly budget?: BudgetState;
  readonly delegation?: DelegationState;
  readonly handoff?: HandoffPacket;
}, request: WorkflowStatusRequest): WorkflowStatusPage {
  const section = request.section ?? "summary";
  const run = input.lifecycle.latestRun;
  const terminal = run?.terminal;
  if (section === "handoff") {
    if (!request.packetHash) throw new Error("Workflow handoff status requires an exact packet hash");
    if (!input.handoff || input.handoff.packetHash !== request.packetHash || run?.handoffPacketHash !== request.packetHash) throw new Error("Workflow handoff packet hash is not bound to the current run");
    const encoded = canonicalJson(input.handoff);
    const chunks: string[] = [];
    let remaining = encoded;
    while (remaining) {
      const chunk = utf8Prefix(remaining, 8_192);
      if (!chunk) throw new Error("Workflow handoff pagination could not make progress");
      chunks.push(chunk);
      remaining = remaining.slice(chunk.length);
    }
    const items = chunks.map((content, index) => Object.freeze({
      packetHash: request.packetHash,
      chunk: index,
      bytes: Buffer.byteLength(content, "utf8"),
      contentHash: hashText(content),
      content,
      readRef: `workflow_status:handoff?packetHash=${request.packetHash}&cursor=${index}`,
    }));
    const page = paginate(section, items, { ...request, limit: Math.min(3, request.limit ?? 3) }, Object.freeze({
      packetHash: request.packetHash,
      totalBytes: Buffer.byteLength(encoded, "utf8"),
      contentHash: hashText(encoded),
      chunks: chunks.length,
    }));
    return page.nextCursor === undefined ? page : Object.freeze({ ...page, summary: Object.freeze({ ...page.summary, nextRef: `workflow_status:handoff?packetHash=${request.packetHash}&cursor=${page.nextCursor}` }) });
  }
  if (request.packetHash !== undefined) throw new Error("Workflow packetHash is only valid for handoff status reads");
  if (section === "inputs") {
    const items = (run?.inputs ?? []).map((entry) => {
      const preview = utf8Prefix(entry.text, TOOL_CONTRACT_LIMITS.previewBytes);
      return Object.freeze({
        sequence: entry.sequence, inputId: entry.inputId, kind: entry.kind, source: entry.source, receivedAt: entry.receivedAt,
        preview, contentHash: hashText(entry.text), truncated: preview !== entry.text, readRef: `run:${run!.runId}/input:${entry.sequence}`,
      });
    });
    return paginate(section, items, request);
  }
  if (section === "file-changes") return paginate(section, terminal?.fileChanges ?? [], request);
  if (section === "artifact-refs") return paginate(section, terminal?.artifactRefs ?? [], request);
  if (section === "evidence-refs") return paginate(section, terminal?.evidenceRefs ?? [], request);
  const tasks = input.delegation ? Object.values(input.delegation.tasks) : [];
  const summary = Object.freeze({
    workflowId: String(input.snapshot.payload.workflow.id ?? ""),
    snapshotHash: input.snapshot.snapshotHash,
    run: run ? {
      runId: run.runId, status: run.status, inputCount: run.inputs.length, deliveredThrough: run.deliveredThrough,
      pendingDelivery: Boolean(run.pendingDelivery), cancellationRequested: run.cancellationRequested,
      terminal: terminal ? { status: terminal.status, summary: terminal.summary, finishedAt: terminal.finishedAt } : undefined,
    } : null,
    team: { tasks: tasks.length, queued: tasks.filter((task) => task.queueState === "queued").length, active: tasks.filter((task) => task.queueState === "active").length, suspended: tasks.filter((task) => task.queueState === "suspended").length, terminal: tasks.filter((task) => task.queueState === "terminal").length },
    budget: input.budget ? { run: input.budget.run, limits: input.budget.limits.run, paused: input.budget.paused, activeBatches: input.budget.activeBatches.length } : null,
    readback: [...(input.handoff ? ["handoff"] : []), "inputs", "file-changes", "artifact-refs", "evidence-refs"],
  });
  return paginate(section, [summary], request, summary);
}
