import type { TSchema } from "typebox";
import type { JsonValue } from "../config/types";
import type { ArtifactCapability } from "../capabilities/types";
import type { ProtectedPathRoot } from "../capabilities/reserved-paths";
import type { ArtifactReference } from "../workflows/runs";
import type { ArtifactWorkspaceHashesV1 } from "./hashes";
import type { CheckpointDescriptorV1 } from "./checkpoints";
import type { ProviderArtifactArgumentContractV1 } from "./action-contracts";
import type {
  ARTIFACT_ACTION_VERSION,
  ARTIFACT_CONTRACT_VERSION,
  ARTIFACT_PROFILE_VERSION,
  ARTIFACT_VIEW_VERSION,
  ArtifactBinding,
} from "./contracts";

export type ArtifactWorkspaceKind = "logical-empty" | "physical";
export type ArtifactWorkspaceSelection = "new" | "existing";
export type ArtifactActionMutability = "read-only" | "mutating";
export type ArtifactActionIdempotency = "idempotent" | "operation-bound";
export type ArtifactActionCompletion = "mandatory" | "optional";

export interface ArtifactActionContract {
  readonly version: typeof ARTIFACT_ACTION_VERSION;
  readonly id: string;
  readonly label: string;
  readonly argumentsSchemaVersion: "1";
  readonly argumentsSchema: TSchema;
  readonly requiredCapabilities: readonly ArtifactCapability[];
  /** Only mandatory actions participate in activation completion reachability. */
  readonly completion: ArtifactActionCompletion;
  readonly mutability: ArtifactActionMutability;
  readonly idempotency: ArtifactActionIdempotency;
}

export interface ArtifactRuntimeProfile {
  readonly contractVersion: typeof ARTIFACT_CONTRACT_VERSION;
  readonly version: typeof ARTIFACT_PROFILE_VERSION;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly id: string;
  readonly optionsSchemaVersion: "1";
  readonly optionsSchema: TSchema;
  readonly bindings: readonly ArtifactBinding[];
  readonly checkpointIds: readonly string[];
  readonly actions: readonly ArtifactActionContract[];
  readonly viewVersion: typeof ARTIFACT_VIEW_VERSION;
}

export interface ArtifactWorkspaceBinding {
  readonly schemaVersion: 1;
  readonly contractVersion: typeof ARTIFACT_CONTRACT_VERSION;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly profileId: string;
  readonly profileVersion: typeof ARTIFACT_PROFILE_VERSION;
  readonly binding: ArtifactBinding;
  /** Explicit choice made for new/existing/either; absent only for logical none. */
  readonly selection?: ArtifactWorkspaceSelection;
  readonly workspace: Readonly<{ id: string; kind: ArtifactWorkspaceKind }>;
  readonly path?: string;
  readonly workspaceHash?: string;
  readonly writerLease?: Readonly<{ required: boolean }>;
  readonly checkpointIds: readonly string[];
  readonly actionIds: readonly string[];
}

export interface ArtifactBindRequest {
  readonly runId: string;
  readonly binding: ArtifactBinding;
  readonly options: Readonly<Record<string, JsonValue>>;
}

export interface ArtifactWorkspaceResolution {
  readonly id: string;
  /** Adapter-resolved canonical candidate. The common binder rechecks containment. */
  readonly path: string;
}
export interface ArtifactWorkspaceListItem {
  readonly id: string;
  readonly label: string;
  readonly summary?: string;
}
export interface ArtifactWorkspaceListPage {
  readonly items: readonly ArtifactWorkspaceListItem[];
  readonly nextCursor?: string;
}
export type ArtifactHandoffValidation =
  | Readonly<{ state: "valid" }>
  | Readonly<{ state: "stale" | "incompatible"; reason: string }>;
/** Physical adapter identity/path hooks. They expose no model or run-state authority. */
export interface ArtifactWorkspaceLifecycle {
  create(input: Readonly<{ projectRoot: string; profileId: string; workspaceId: string; options: Readonly<Record<string, JsonValue>> }>): ArtifactWorkspaceResolution;
  resolve(input: Readonly<{ projectRoot: string; profileId: string; workspaceId: string; options: Readonly<Record<string, JsonValue>> }>): ArtifactWorkspaceResolution | undefined;
  list(input: Readonly<{ projectRoot: string; profileId: string; options: Readonly<Record<string, JsonValue>>; limit: number; cursor?: string }>): ArtifactWorkspaceListPage;
  validateHandoffReference?(input: Readonly<{
    projectRoot: string;
    profileId: string;
    reference: ArtifactReference;
    workspace: ArtifactWorkspaceResolution;
    hashes: ArtifactWorkspaceHashesV1;
  }>): ArtifactHandoffValidation;
}

export interface ArtifactStatusPageRequest {
  readonly limit: number;
  readonly cursor?: string;
}
export interface ArtifactViewRefV1 {
  readonly id: string;
  readonly kind: string;
  readonly digest?: string;
  readonly bytes?: number;
}
export interface ArtifactStatusViewV1 {
  readonly schemaVersion: typeof ARTIFACT_VIEW_VERSION;
  readonly contractVersion: typeof ARTIFACT_CONTRACT_VERSION;
  readonly adapter: Readonly<{ id: string; version: string }>;
  readonly profile: Readonly<{ id: string; version: string }>;
  readonly workspace: Readonly<{ id: string; kind: ArtifactWorkspaceKind; binding: ArtifactBinding; path?: string; hash?: string }>;
  readonly status: "ready" | "blocked" | "complete";
  readonly summary: string;
  readonly checkpoints: readonly Readonly<{ id: string; state: "pending" | "ready" | "approved" | "not-applicable"; digest?: string }>[];
  /** Facade output always supplies the provider contract; adapter-owned raw views omit it. */
  readonly actions: readonly Readonly<{ id: string; label: string; available: boolean; reason?: string } & Partial<ProviderArtifactArgumentContractV1>>[];
  readonly items: readonly Readonly<{ id: string; kind: string; label: string; state: string; summary?: string; ref?: string }>[];
  readonly page: Readonly<{ limit: number; cursor?: string; nextCursor?: string }>;
  readonly refs: readonly ArtifactViewRefV1[];
}

export interface ArtifactActionResultV1 {
  readonly schemaVersion: typeof ARTIFACT_ACTION_VERSION;
  /** Exact W13 attempt ID; callers cannot supply or override it. */
  readonly operationId: string;
  readonly actionId: string;
  readonly status: "completed" | "blocked";
  readonly summary: string;
  readonly changed: boolean;
  readonly workspaceHash?: string;
  readonly data: Readonly<Record<string, JsonValue>>;
  readonly refs: readonly ArtifactViewRefV1[];
}

export interface ArtifactOperationRecoveryContext {
  readonly binding: ArtifactWorkspaceBinding;
  readonly hashes: ArtifactWorkspaceHashesV1;
  readonly operation: Readonly<{
    operationId: string;
    actionId: string;
    inputHash: string;
    expectedWorkspaceHash: string;
    intentAt: string;
  }>;
}
export type ArtifactActionRecoveryResult =
  | Readonly<{ state: "applied"; result: ArtifactActionResultV1 }>
  | Readonly<{ state: "unknown"; diagnostic: string }>;

export interface ArtifactCompletionResult {
  readonly state: "satisfied" | "unsatisfied" | "not-present";
  readonly issues?: readonly string[];
}

export type ArtifactEvidenceReferenceV1 =
  | Readonly<{ kind: "tool"; attemptId: string }>
  | Readonly<{ kind: "command"; attemptId: string }>
  | Readonly<{ kind: "repository"; path: string; digest: string }>;
export type VerifiedArtifactEvidenceV1 =
  | Readonly<{ kind: "tool"; attemptId: string; operation: string; inputHash: string; resultHash: string }>
  | Readonly<{ kind: "command"; attemptId: string; effect: "shell" | "git"; operation: string; inputHash: string; resultHash: string }>
  | Readonly<{ kind: "repository"; path: string; digest: string; bytes: number }>;

export interface ArtifactStatusContext {
  readonly binding: ArtifactWorkspaceBinding;
  readonly capabilities: readonly ArtifactCapability[];
  /** Cooperative cancellation from the active Pi tool call. */
  readonly signal?: AbortSignal;
  /** Fresh reader evidence; physical adapters must return this hash in their view. */
  readonly hashes?: ArtifactWorkspaceHashesV1;
}
export interface ArtifactActionContext extends ArtifactStatusContext {
  /** Harness-minted W13 attempt ID, also used as the artifact operation ID. */
  readonly operationId: string;
  readonly expectedWorkspaceHash?: string;
  /** Package-issued verifier for durable W13 attempt and current repository evidence. */
  readonly verifyEvidence?: (references: readonly ArtifactEvidenceReferenceV1[]) => readonly VerifiedArtifactEvidenceV1[];
  enqueueMutation<T>(relativePath: string, callback: () => T | Promise<T>): Promise<T>;
}

/** Artifact-only lifecycle surface. Deliberately contains no model, transcript, routing, delegation, or run mutation hook. */
export interface ArtifactCheckpointDescriptorInput {
  readonly binding: ArtifactWorkspaceBinding;
  readonly checkpointId: string;
  readonly hashes: ArtifactWorkspaceHashesV1;
}

export interface ArtifactAdapter {
  readonly contractVersion: typeof ARTIFACT_CONTRACT_VERSION;
  readonly id: string;
  readonly version: string;
  readonly profiles: readonly ArtifactRuntimeProfile[];
  /** Adapter-owned roots automatically incorporated into generic filesystem policy. */
  protectedWorkspaceRoots?(input: Readonly<{ projectRoot: string; profile: ArtifactRuntimeProfile; options: Readonly<Record<string, JsonValue>> }>): readonly ProtectedPathRoot[];
  readonly workspaceLifecycle?: ArtifactWorkspaceLifecycle;
  bind(profile: ArtifactRuntimeProfile, request: ArtifactBindRequest): ArtifactWorkspaceBinding;
  status(context: ArtifactStatusContext, page: ArtifactStatusPageRequest): ArtifactStatusViewV1 | Promise<ArtifactStatusViewV1>;
  executeAction?(context: ArtifactActionContext, action: ArtifactActionContract, argumentsValue: Readonly<Record<string, JsonValue>>): ArtifactActionResultV1 | Promise<ArtifactActionResultV1>;
  /** Deterministic adapter-owned contributor contract consumed by the generic approval service. */
  checkpointDescriptor?(input: ArtifactCheckpointDescriptorInput): CheckpointDescriptorV1;
  /** Read adapter-owned state to prove an interrupted physical mutation applied, or return unknown. Never redispatches. */
  reconcileAction(context: ArtifactOperationRecoveryContext, action: ArtifactActionContract): ArtifactActionRecoveryResult;
  validateCompletion(binding: ArtifactWorkspaceBinding): ArtifactCompletionResult | Promise<ArtifactCompletionResult>;
}
