import type { TSchema } from "typebox";
import type { JsonValue } from "../config/types";
import type { ArtifactCapability } from "../capabilities/types";
import type {
  ARTIFACT_ACTION_VERSION,
  ARTIFACT_CONTRACT_VERSION,
  ARTIFACT_PROFILE_VERSION,
  ARTIFACT_VIEW_VERSION,
  ArtifactBinding,
} from "./contracts";

export type ArtifactWorkspaceKind = "logical-empty" | "physical";
export type ArtifactActionMutability = "read-only" | "mutating";
export type ArtifactActionIdempotency = "idempotent" | "operation-bound";

export interface ArtifactActionContract {
  readonly version: typeof ARTIFACT_ACTION_VERSION;
  readonly id: string;
  readonly label: string;
  readonly argumentsSchemaVersion: "1";
  readonly argumentsSchema: TSchema;
  readonly requiredCapabilities: readonly ArtifactCapability[];
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
  readonly actions: readonly Readonly<{ id: string; label: string; available: boolean; reason?: string }>[];
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

export interface ArtifactCompletionResult {
  readonly state: "satisfied" | "unsatisfied" | "not-present";
  readonly issues?: readonly string[];
}

export interface ArtifactStatusContext {
  readonly binding: ArtifactWorkspaceBinding;
  readonly capabilities: readonly ArtifactCapability[];
}
export interface ArtifactActionContext extends ArtifactStatusContext {
  /** Harness-minted W13 attempt ID, also used as the artifact operation ID. */
  readonly operationId: string;
  readonly expectedWorkspaceHash?: string;
  enqueueMutation<T>(relativePath: string, callback: () => T | Promise<T>): Promise<T>;
}

/** Artifact-only lifecycle surface. Deliberately contains no model, transcript, routing, delegation, or run mutation hook. */
export interface ArtifactAdapter {
  readonly contractVersion: typeof ARTIFACT_CONTRACT_VERSION;
  readonly id: string;
  readonly version: string;
  readonly profiles: readonly ArtifactRuntimeProfile[];
  bind(profile: ArtifactRuntimeProfile, request: ArtifactBindRequest): ArtifactWorkspaceBinding;
  status(context: ArtifactStatusContext, page: ArtifactStatusPageRequest): ArtifactStatusViewV1 | Promise<ArtifactStatusViewV1>;
  executeAction?(context: ArtifactActionContext, action: ArtifactActionContract, argumentsValue: Readonly<Record<string, JsonValue>>): ArtifactActionResultV1 | Promise<ArtifactActionResultV1>;
  validateCompletion(binding: ArtifactWorkspaceBinding): ArtifactCompletionResult | Promise<ArtifactCompletionResult>;
}
