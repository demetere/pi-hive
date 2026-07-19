import { isAbsolute, relative, resolve } from "node:path";
import { Value } from "typebox/value";
import { canonicalJson } from "../config/snapshot-canonical";
import { resolveCanonicalPath, resolveContainedPath } from "../core/safe-path";
import type { ArtifactCapability } from "../capabilities/types";
import { boundedJson, boundedText, plainRecord } from "../workflows/values";
import {
  ARTIFACT_ACTION_VERSION,
  ARTIFACT_CONTRACT_LIMITS,
  ARTIFACT_CONTRACT_VERSION,
  ARTIFACT_VIEW_VERSION,
} from "./contracts";
import { isPackageArtifactCaller, type PackageArtifactCallerContext } from "./internal/caller";
import type {
  ArtifactActionContext,
  ArtifactActionResultV1,
  ArtifactAdapter,
  ArtifactRuntimeProfile,
  ArtifactStatusViewV1,
  ArtifactWorkspaceBinding,
} from "./types";

export type ArtifactFacadeErrorCode =
  | "UNTRUSTED_CALLER"
  | "CAPABILITY_DENIED"
  | "REQUEST_INVALID"
  | "ACTION_UNKNOWN"
  | "ARGUMENTS_INVALID"
  | "WORKSPACE_MISMATCH"
  | "WORKSPACE_ESCAPE"
  | "ATTEMPT_INVALID"
  | "MUTATION_QUEUE_REQUIRED"
  | "VIEW_INVALID"
  | "VIEW_LIMIT_EXCEEDED"
  | "RESULT_INVALID"
  | "RESULT_LIMIT_EXCEEDED";

export class ArtifactFacadeError extends Error {
  readonly code: ArtifactFacadeErrorCode;
  constructor(code: ArtifactFacadeErrorCode, message: string) {
    super(message);
    this.name = "ArtifactFacadeError";
    this.code = code;
  }
}

export type ArtifactMutationQueue = <T>(target: string, operationId: string, callback: () => T | Promise<T>) => Promise<T>;

function requireCaller(value: PackageArtifactCallerContext, binding: ArtifactWorkspaceBinding): PackageArtifactCallerContext {
  if (!isPackageArtifactCaller(value)) throw new ArtifactFacadeError("UNTRUSTED_CALLER", "Artifact facade requires an active package-minted caller context");
  if (canonicalJson(value.workspace) !== canonicalJson(binding)) throw new ArtifactFacadeError("WORKSPACE_MISMATCH", "Artifact caller workspace does not match trusted run state");
  return value;
}
function requireCapability(caller: PackageArtifactCallerContext, capability: ArtifactCapability): void {
  if (!caller.capabilities.includes(capability)) throw new ArtifactFacadeError("CAPABILITY_DENIED", `Artifact capability ${capability} is required`);
}
function requireTool(caller: PackageArtifactCallerContext, tool: "artifact_status" | "artifact_action"): void {
  if (!caller.tools.includes(tool)) throw new ArtifactFacadeError("UNTRUSTED_CALLER", `Immutable authority does not grant trusted tool ${tool}`);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length || keys.some((key) => !(key in value))) throw new ArtifactFacadeError("REQUEST_INVALID", `${label} contains unknown or missing fields`);
}
function validateId(value: unknown, label: string, code: ArtifactFacadeErrorCode = "REQUEST_INVALID"): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value) || Buffer.byteLength(value, "utf8") > ARTIFACT_CONTRACT_LIMITS.idBytes) {
    throw new ArtifactFacadeError(code, `${label} is invalid`);
  }
  return value;
}
function boundJson(value: unknown, label: string, bytes: number, code: ArtifactFacadeErrorCode): void {
  try {
    boundedJson(value, label, { bytes, depth: ARTIFACT_CONTRACT_LIMITS.jsonDepth, nodes: ARTIFACT_CONTRACT_LIMITS.jsonNodes });
  } catch (error) {
    throw new ArtifactFacadeError(code, String(error instanceof Error ? error.message : error));
  }
}
function containsWorkspaceSpoof(value: unknown, nodes = { count: 0 }, depth = 0): boolean {
  if (++nodes.count > ARTIFACT_CONTRACT_LIMITS.jsonNodes || depth > ARTIFACT_CONTRACT_LIMITS.jsonDepth) return true;
  if (Array.isArray(value)) return value.some((item) => containsWorkspaceSpoof(item, nodes, depth + 1));
  if (!plainRecord(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (["workspace", "workspaceId", "workspacePath", "workspaceRoot"].includes(key)) return true;
    if (containsWorkspaceSpoof(child, nodes, depth + 1)) return true;
  }
  return false;
}
function exactDto(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], code: ArtifactFacadeErrorCode, label: string): void {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || required.some((key) => !(key in value))) throw new ArtifactFacadeError(code, `${label} fields are invalid`);
}
function validCursor(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= ARTIFACT_CONTRACT_LIMITS.cursorCharacters && Buffer.byteLength(value, "utf8") <= ARTIFACT_CONTRACT_LIMITS.cursorBytes;
}
function pageRequest(raw: unknown): Readonly<{ limit: number; cursor?: string }> {
  if (!plainRecord(raw)) throw new ArtifactFacadeError("REQUEST_INVALID", "Artifact status page must be an object");
  exactDto(raw, [], ["limit", "cursor"], "REQUEST_INVALID", "Artifact status page");
  const limit = raw.limit === undefined ? 20 : raw.limit;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > ARTIFACT_CONTRACT_LIMITS.pageSize) throw new ArtifactFacadeError("REQUEST_INVALID", "Artifact status page limit is invalid");
  if (raw.cursor !== undefined && !validCursor(raw.cursor)) throw new ArtifactFacadeError("REQUEST_INVALID", "Artifact status cursor is invalid");
  return Object.freeze({ limit: Number(limit), ...(raw.cursor === undefined ? {} : { cursor: raw.cursor }) });
}
function digest(value: unknown): boolean { return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value); }
function boundedString(value: unknown, bytes: number = ARTIFACT_CONTRACT_LIMITS.summaryBytes): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= bytes;
}
function validateRefs(value: unknown, code: ArtifactFacadeErrorCode): void {
  if (!Array.isArray(value) || value.length > ARTIFACT_CONTRACT_LIMITS.refs) throw new ArtifactFacadeError(code, "Artifact refs exceed their bound");
  const ids = new Set<string>();
  for (const ref of value) {
    if (!plainRecord(ref)) throw new ArtifactFacadeError(code, "Artifact ref is invalid");
    exactDto(ref, ["id", "kind"], ["digest", "bytes"], code, "Artifact ref");
    if (!boundedString(ref.id, ARTIFACT_CONTRACT_LIMITS.idBytes) || !boundedString(ref.kind, ARTIFACT_CONTRACT_LIMITS.idBytes) || ids.has(ref.id)
      || (ref.digest !== undefined && !digest(ref.digest)) || (ref.bytes !== undefined && (!Number.isSafeInteger(ref.bytes) || Number(ref.bytes) < 0))) throw new ArtifactFacadeError(code, "Artifact ref is invalid");
    ids.add(ref.id);
  }
}
function validateView(view: unknown, adapter: ArtifactAdapter, profile: ArtifactRuntimeProfile, binding: ArtifactWorkspaceBinding, request: Readonly<{ limit: number; cursor?: string }>): ArtifactStatusViewV1 {
  boundJson(view, "Artifact status view", ARTIFACT_CONTRACT_LIMITS.viewBytes, "VIEW_LIMIT_EXCEEDED");
  if (!plainRecord(view)) throw new ArtifactFacadeError("VIEW_INVALID", "Artifact status view must be an object");
  exactDto(view, ["schemaVersion", "contractVersion", "adapter", "profile", "workspace", "status", "summary", "checkpoints", "actions", "items", "page", "refs"], [], "VIEW_INVALID", "Artifact status view");
  if (!plainRecord(view.adapter) || !plainRecord(view.profile) || !plainRecord(view.workspace)) throw new ArtifactFacadeError("VIEW_INVALID", "Artifact status view identity is invalid");
  exactDto(view.adapter, ["id", "version"], [], "VIEW_INVALID", "Artifact status adapter");
  exactDto(view.profile, ["id", "version"], [], "VIEW_INVALID", "Artifact status profile");
  exactDto(view.workspace, ["id", "kind", "binding"], ["path", "hash"], "VIEW_INVALID", "Artifact status workspace");
  if (view.schemaVersion !== ARTIFACT_VIEW_VERSION || view.contractVersion !== ARTIFACT_CONTRACT_VERSION || view.adapter.id !== adapter.id || view.adapter.version !== adapter.version
    || view.profile.id !== profile.id || view.profile.version !== profile.version || view.workspace.id !== binding.workspace.id || view.workspace.kind !== binding.workspace.kind
    || view.workspace.binding !== binding.binding || view.workspace.path !== binding.path || view.workspace.hash !== binding.workspaceHash) throw new ArtifactFacadeError("VIEW_INVALID", "Artifact status view identity is invalid");
  if (view.status !== "ready" && view.status !== "blocked" && view.status !== "complete") throw new ArtifactFacadeError("VIEW_INVALID", "Artifact status state is invalid");
  try { boundedText(view.summary, "Artifact status summary", ARTIFACT_CONTRACT_LIMITS.summaryBytes); }
  catch (error) { throw new ArtifactFacadeError("VIEW_INVALID", String(error instanceof Error ? error.message : error)); }
  if (!Array.isArray(view.checkpoints) || view.checkpoints.length > ARTIFACT_CONTRACT_LIMITS.viewItems || !Array.isArray(view.actions) || view.actions.length > ARTIFACT_CONTRACT_LIMITS.viewItems
    || !Array.isArray(view.items) || view.items.length > request.limit || view.items.length > ARTIFACT_CONTRACT_LIMITS.viewItems) throw new ArtifactFacadeError("VIEW_INVALID", "Artifact status collections exceed their bounds");
  const checkpointIds = new Set<string>();
  for (const checkpoint of view.checkpoints) {
    if (!plainRecord(checkpoint)) throw new ArtifactFacadeError("VIEW_INVALID", "Artifact checkpoint is invalid");
    exactDto(checkpoint, ["id", "state"], ["digest"], "VIEW_INVALID", "Artifact checkpoint");
    if (typeof checkpoint.id !== "string" || !profile.checkpointIds.includes(checkpoint.id) || checkpointIds.has(checkpoint.id)
      || !["pending", "ready", "approved", "not-applicable"].includes(String(checkpoint.state)) || (checkpoint.digest !== undefined && !digest(checkpoint.digest))) throw new ArtifactFacadeError("VIEW_INVALID", "Artifact checkpoint is invalid");
    checkpointIds.add(checkpoint.id);
  }
  const actionIds = new Set<string>();
  for (const action of view.actions) {
    if (!plainRecord(action)) throw new ArtifactFacadeError("VIEW_INVALID", "Artifact action view is invalid");
    exactDto(action, ["id", "label", "available"], ["reason"], "VIEW_INVALID", "Artifact action view");
    const contract = typeof action.id === "string" ? profile.actions.find((candidate) => candidate.id === action.id) : undefined;
    if (!contract || actionIds.has(contract.id) || action.label !== contract.label || typeof action.available !== "boolean" || (action.reason !== undefined && !boundedString(action.reason))) throw new ArtifactFacadeError("VIEW_INVALID", "Artifact action view is invalid");
    actionIds.add(contract.id);
  }
  const itemIds = new Set<string>();
  for (const item of view.items) {
    if (!plainRecord(item)) throw new ArtifactFacadeError("VIEW_INVALID", "Artifact status item is invalid");
    exactDto(item, ["id", "kind", "label", "state"], ["summary", "ref"], "VIEW_INVALID", "Artifact status item");
    if (!boundedString(item.id, ARTIFACT_CONTRACT_LIMITS.idBytes) || itemIds.has(item.id) || !boundedString(item.kind, ARTIFACT_CONTRACT_LIMITS.idBytes)
      || !boundedString(item.label) || !boundedString(item.state, ARTIFACT_CONTRACT_LIMITS.idBytes) || (item.summary !== undefined && !boundedString(item.summary))
      || (item.ref !== undefined && !boundedString(item.ref, ARTIFACT_CONTRACT_LIMITS.idBytes))) throw new ArtifactFacadeError("VIEW_INVALID", "Artifact status item is invalid");
    itemIds.add(item.id);
  }
  if (!plainRecord(view.page)) throw new ArtifactFacadeError("VIEW_INVALID", "Artifact status pagination is invalid");
  exactDto(view.page, ["limit"], ["cursor", "nextCursor"], "VIEW_INVALID", "Artifact status page");
  const cursorMatches = request.cursor === undefined ? view.page.cursor === undefined : view.page.cursor === request.cursor;
  if (view.page.limit !== request.limit || !cursorMatches || (view.page.nextCursor !== undefined && !validCursor(view.page.nextCursor))) throw new ArtifactFacadeError("VIEW_INVALID", "Artifact status pagination is invalid");
  validateRefs(view.refs, "VIEW_INVALID");
  return Object.freeze(structuredClone(view)) as unknown as ArtifactStatusViewV1;
}
function validateResult(result: unknown, actionId: string, operationId: string): ArtifactActionResultV1 {
  boundJson(result, "Artifact action result", ARTIFACT_CONTRACT_LIMITS.resultBytes, "RESULT_LIMIT_EXCEEDED");
  if (!plainRecord(result)) throw new ArtifactFacadeError("RESULT_INVALID", "Artifact action result must be an object");
  const required = ["schemaVersion", "operationId", "actionId", "status", "summary", "changed", "data", "refs"];
  const optional = new Set([...required, "workspaceHash"]);
  if (Object.keys(result).some((key) => !optional.has(key)) || required.some((key) => !(key in result)) || result.schemaVersion !== ARTIFACT_ACTION_VERSION
    || result.operationId !== operationId || result.actionId !== actionId || (result.status !== "completed" && result.status !== "blocked") || typeof result.changed !== "boolean"
    || !plainRecord(result.data) || (result.workspaceHash !== undefined && !digest(result.workspaceHash))) throw new ArtifactFacadeError("RESULT_INVALID", "Artifact action result fields or authority identity are invalid");
  try { boundedText(result.summary, "Artifact action summary", ARTIFACT_CONTRACT_LIMITS.summaryBytes); }
  catch (error) { throw new ArtifactFacadeError("RESULT_INVALID", String(error instanceof Error ? error.message : error)); }
  validateRefs(result.refs, "RESULT_INVALID");
  return Object.freeze(structuredClone(result)) as unknown as ArtifactActionResultV1;
}

export class ArtifactFacade {
  private readonly adapter: ArtifactAdapter;
  private readonly profile: ArtifactRuntimeProfile;
  private readonly binding: ArtifactWorkspaceBinding;
  private readonly mutationQueue?: ArtifactMutationQueue;
  constructor(input: { readonly adapter: ArtifactAdapter; readonly profile: ArtifactRuntimeProfile; readonly binding: ArtifactWorkspaceBinding; readonly mutationQueue?: ArtifactMutationQueue }) {
    if (input.adapter.contractVersion !== ARTIFACT_CONTRACT_VERSION || input.profile.contractVersion !== ARTIFACT_CONTRACT_VERSION || input.binding.contractVersion !== ARTIFACT_CONTRACT_VERSION
      || input.adapter.id !== input.profile.adapterId || input.adapter.version !== input.profile.adapterVersion || input.binding.adapterId !== input.adapter.id || input.binding.adapterVersion !== input.adapter.version
      || input.binding.profileId !== input.profile.id || input.binding.profileVersion !== input.profile.version || !input.profile.bindings.includes(input.binding.binding)) throw new ArtifactFacadeError("WORKSPACE_MISMATCH", "Artifact facade contract/profile/workspace identity is inconsistent");
    this.adapter = input.adapter;
    this.profile = input.profile;
    this.binding = input.binding;
    this.mutationQueue = input.mutationQueue;
  }

  async status(rawCaller: PackageArtifactCallerContext, rawPage: { readonly limit?: number; readonly cursor?: string } = {}): Promise<ArtifactStatusViewV1> {
    const caller = requireCaller(rawCaller, this.binding);
    requireTool(caller, "artifact_status");
    requireCapability(caller, "read");
    const page = pageRequest(rawPage);
    const view = await this.adapter.status(Object.freeze({ binding: this.binding, capabilities: caller.capabilities }), page);
    return validateView(view, this.adapter, this.profile, this.binding, page);
  }

  async action(rawCaller: PackageArtifactCallerContext, rawRequest: unknown, execution: { readonly attemptId: string }): Promise<ArtifactActionResultV1> {
    const caller = requireCaller(rawCaller, this.binding);
    requireTool(caller, "artifact_action");
    if (!plainRecord(rawRequest)) throw new ArtifactFacadeError("REQUEST_INVALID", "Artifact action request must be an object");
    exactKeys(rawRequest, ["actionId", "arguments"], "Artifact action request");
    const actionId = validateId(rawRequest.actionId, "Artifact action ID");
    const action = this.profile.actions.find((candidate) => candidate.id === actionId);
    if (!action || !this.binding.actionIds.includes(actionId) || !this.adapter.executeAction) throw new ArtifactFacadeError("ACTION_UNKNOWN", `Artifact action ${actionId} is not supported by the active profile`);
    if (!plainRecord(rawRequest.arguments)) throw new ArtifactFacadeError("ARGUMENTS_INVALID", "Artifact action arguments must be an object");
    try { boundedJson(rawRequest.arguments, "Artifact action arguments", { bytes: ARTIFACT_CONTRACT_LIMITS.argumentsBytes, depth: ARTIFACT_CONTRACT_LIMITS.jsonDepth, nodes: ARTIFACT_CONTRACT_LIMITS.jsonNodes, rootRecord: true }); }
    catch (error) { throw new ArtifactFacadeError("ARGUMENTS_INVALID", String(error instanceof Error ? error.message : error)); }
    if (containsWorkspaceSpoof(rawRequest.arguments) || !Value.Check(action.argumentsSchema, rawRequest.arguments)) throw new ArtifactFacadeError("ARGUMENTS_INVALID", "Artifact action arguments contain unknown, invalid, or workspace-spoofing fields");
    for (const capability of action.requiredCapabilities) requireCapability(caller, capability);
    const operationId = validateId(execution?.attemptId, "Artifact operation/attempt ID", "ATTEMPT_INVALID");
    if (action.mutability === "mutating" && (!this.mutationQueue || !this.binding.path || !this.binding.workspaceHash)) throw new ArtifactFacadeError("MUTATION_QUEUE_REQUIRED", "Mutating artifact actions require a trusted workspace path/hash and Pi mutation queue");
    const canonicalWorkspace = action.mutability === "mutating" && this.binding.path ? resolveCanonicalPath(this.binding.path) : undefined;
    if (action.mutability === "mutating" && (!canonicalWorkspace || !canonicalWorkspace.exists)) throw new ArtifactFacadeError("WORKSPACE_ESCAPE", "Trusted artifact workspace cannot be canonically resolved");
    type MutationSettlement = Readonly<{ status: "fulfilled" }> | Readonly<{ status: "rejected"; reason: unknown }>;
    const mutationSettlements: Array<Promise<MutationSettlement>> = [];
    let queued = 0;
    const enqueueMutation: ArtifactActionContext["enqueueMutation"] = <T>(relativePath: string, callback: () => T | Promise<T>): Promise<T> => {
      const mutation = (async (): Promise<T> => {
        if (action.mutability !== "mutating" || !this.mutationQueue || !this.binding.path) throw new ArtifactFacadeError("MUTATION_QUEUE_REQUIRED", "Artifact mutation queue is unavailable");
        if (typeof callback !== "function" || typeof relativePath !== "string" || !relativePath || relativePath.includes("\\") || isAbsolute(relativePath) || relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..") || Buffer.byteLength(relativePath, "utf8") > 4_096) throw new ArtifactFacadeError("WORKSPACE_ESCAPE", "Artifact mutation target escapes or is invalid for the trusted workspace");
        const target = resolve(this.binding.path, relativePath);
        const rel = relative(this.binding.path, target);
        if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new ArtifactFacadeError("WORKSPACE_ESCAPE", "Artifact mutation target escapes the trusted workspace");
        const authorized = resolveContainedPath(this.binding.path, target, { allowMissing: true });
        if (!authorized || !canonicalWorkspace) throw new ArtifactFacadeError("WORKSPACE_ESCAPE", "Artifact mutation target cannot be canonically contained in the trusted workspace");
        const recheckCanonicalTarget = (): void => {
          const currentWorkspace = resolveCanonicalPath(this.binding.path!);
          const currentTarget = resolveContainedPath(this.binding.path!, target, { allowMissing: true });
          if (!currentWorkspace || currentWorkspace.canonicalPath !== canonicalWorkspace.canonicalPath || !currentTarget || currentTarget.canonicalPath !== authorized.canonicalPath) {
            throw new ArtifactFacadeError("WORKSPACE_ESCAPE", "Artifact mutation target changed or escaped canonical workspace containment");
          }
        };
        queued += 1;
        return this.mutationQueue(authorized.canonicalPath, operationId, async () => {
          recheckCanonicalTarget();
          try { return await callback(); }
          finally { recheckCanonicalTarget(); }
        });
      })();
      mutationSettlements.push(mutation.then<MutationSettlement, MutationSettlement>(
        () => Object.freeze({ status: "fulfilled" }),
        (reason: unknown) => Object.freeze({ status: "rejected", reason }),
      ));
      return mutation;
    };
    const context: ArtifactActionContext = Object.freeze({ binding: this.binding, capabilities: caller.capabilities, operationId, expectedWorkspaceHash: this.binding.workspaceHash, enqueueMutation });
    const argumentsValue = Object.freeze(structuredClone(rawRequest.arguments)) as never;
    let adapterExecution: Readonly<{ status: "fulfilled"; result: ArtifactActionResultV1 }> | Readonly<{ status: "rejected"; reason: unknown }>;
    try {
      adapterExecution = Object.freeze({ status: "fulfilled", result: validateResult(await this.adapter.executeAction(context, action, argumentsValue), actionId, operationId) });
    } catch (reason) {
      adapterExecution = Object.freeze({ status: "rejected", reason });
    }
    const settlements: MutationSettlement[] = [];
    let drained = 0;
    while (drained < mutationSettlements.length) {
      const pending = mutationSettlements.slice(drained);
      settlements.push(...await Promise.all(pending));
      drained += pending.length;
    }
    if (adapterExecution.status === "rejected") throw adapterExecution.reason;
    const mutationFailure = settlements.find((settlement): settlement is Readonly<{ status: "rejected"; reason: unknown }> => settlement.status === "rejected");
    if (mutationFailure) throw mutationFailure.reason;
    if (adapterExecution.result.changed && queued === 0) throw new ArtifactFacadeError("MUTATION_QUEUE_REQUIRED", "Artifact action reported mutation without using the trusted mutation queue");
    return adapterExecution.result;
  }

  async validateCompletion() {
    return this.adapter.validateCompletion(this.binding);
  }
}
