import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { JsonValue } from "../config/types";
import { resolveCanonicalPath, resolveContainedPath } from "../core/safe-path";
import { boundedJson, boundedText, plainRecord } from "../workflows/values";
import type { ArtifactReference } from "../workflows/runs";
import {
  ARTIFACT_CONTRACT_LIMITS,
  ARTIFACT_CONTRACT_VERSION,
  ARTIFACT_PROFILE_VERSION,
  type ArtifactBinding,
} from "./contracts";
import { hashArtifactWorkspace, type ArtifactWorkspaceHashesV1 } from "./hashes";
import type {
  ArtifactAdapter,
  ArtifactRuntimeProfile,
  ArtifactWorkspaceBinding,
  ArtifactWorkspaceListItem,
  ArtifactWorkspaceListPage,
  ArtifactWorkspaceResolution,
  ArtifactWorkspaceSelection,
} from "./types";

export const ARTIFACT_WORKSPACE_LIMITS = Object.freeze({
  listPage: 100,
  listItems: 100,
  listBytes: 65_536,
  dtoBytes: 16_384,
});

export interface PhysicalWorkspaceSelection {
  readonly mode: ArtifactWorkspaceSelection;
  readonly workspaceId: string;
}
export interface BindPhysicalArtifactWorkspaceInput {
  readonly projectRoot: string;
  readonly adapter: ArtifactAdapter;
  readonly profile: ArtifactRuntimeProfile;
  readonly runId: string;
  readonly configuredBinding: ArtifactBinding;
  readonly options: Readonly<Record<string, JsonValue>>;
  readonly selection?: PhysicalWorkspaceSelection;
  readonly handoffReference?: ArtifactReference;
}

function contractId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)
    || Buffer.byteLength(value, "utf8") > ARTIFACT_CONTRACT_LIMITS.idBytes) throw new Error(`${label} is invalid`);
  return value;
}
function cursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || value.length > ARTIFACT_CONTRACT_LIMITS.cursorCharacters
    || Buffer.byteLength(value, "utf8") > ARTIFACT_CONTRACT_LIMITS.cursorBytes) throw new Error("Artifact workspace list cursor is invalid");
  return value;
}
function requireLifecycle(adapter: ArtifactAdapter) {
  if (!adapter.workspaceLifecycle) throw new Error(`Artifact adapter ${adapter.id} has no physical workspace lifecycle`);
  return adapter.workspaceLifecycle;
}
function validateIdentity(adapter: ArtifactAdapter, profile: ArtifactRuntimeProfile): void {
  if (adapter.contractVersion !== ARTIFACT_CONTRACT_VERSION || profile.contractVersion !== ARTIFACT_CONTRACT_VERSION
    || profile.version !== ARTIFACT_PROFILE_VERSION || profile.adapterId !== adapter.id || profile.adapterVersion !== adapter.version
    || !adapter.profiles.includes(profile)) throw new Error("Artifact adapter/profile workspace identity is inconsistent");
}
function validateResolution(projectRoot: string, expectedId: string, value: unknown): ArtifactWorkspaceResolution {
  if (!plainRecord(value) || Object.keys(value).some((key) => key !== "id" && key !== "path") || value.id !== expectedId
    || typeof value.path !== "string" || !isAbsolute(value.path) || Buffer.byteLength(value.path, "utf8") > 4_096) {
    throw new Error("Artifact adapter returned an invalid workspace identity");
  }
  const project = resolveCanonicalPath(projectRoot);
  const contained = resolveContainedPath(projectRoot, value.path);
  if (!project?.exists || !contained || !contained.exists) throw new Error("Artifact workspace is not canonically contained in the project");
  const stat = lstatSync(contained.canonicalPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Artifact workspace must resolve to a physical contained directory");
  return Object.freeze({ id: expectedId, path: contained.canonicalPath });
}
function allowedChoice(configured: ArtifactBinding, mode: ArtifactWorkspaceSelection): boolean {
  return configured === "either" || configured === mode;
}

/** Bind one physical workspace from an explicit choice. There is deliberately no latest/default branch. */
export function bindPhysicalArtifactWorkspace(input: BindPhysicalArtifactWorkspaceInput): ArtifactWorkspaceBinding {
  validateIdentity(input.adapter, input.profile);
  if (input.configuredBinding === "none") throw new Error("none binding is logical-only and cannot bind a physical workspace");
  if (!input.profile.bindings.includes(input.configuredBinding)) throw new Error(`Binding ${input.configuredBinding} is incompatible with profile ${input.profile.id}`);
  if (!input.selection) throw new Error("Physical artifact binding requires an explicit new or existing workspace selection; latest is never implicit");
  if (!allowedChoice(input.configuredBinding, input.selection.mode)) throw new Error(`${input.configuredBinding} binding cannot select a ${input.selection.mode} workspace`);
  const workspaceId = contractId(input.selection.workspaceId, "Artifact workspace ID");
  contractId(input.runId, "Artifact run ID");
  boundedJson(input.options, "Artifact workspace options", { bytes: ARTIFACT_CONTRACT_LIMITS.optionsBytes, depth: ARTIFACT_CONTRACT_LIMITS.jsonDepth, nodes: ARTIFACT_CONTRACT_LIMITS.jsonNodes, rootRecord: true });
  const lifecycle = requireLifecycle(input.adapter);
  let raw: ArtifactWorkspaceResolution | undefined;
  if (input.selection.mode === "new") {
    if (lifecycle.resolve({ projectRoot: input.projectRoot, profileId: input.profile.id, workspaceId, options: input.options })) throw new Error(`Artifact workspace ${workspaceId} already exists; create collision refused`);
    raw = lifecycle.create({ projectRoot: input.projectRoot, profileId: input.profile.id, workspaceId, options: input.options });
  } else {
    raw = lifecycle.resolve({ projectRoot: input.projectRoot, profileId: input.profile.id, workspaceId, options: input.options });
    if (!raw) throw new Error(`Existing artifact workspace ${workspaceId} was not found`);
  }
  const resolution = validateResolution(input.projectRoot, workspaceId, raw);
  const hashes = hashArtifactWorkspace(resolution.path);
  if (input.handoffReference) {
    if (input.selection.mode !== "existing") throw new Error("Handoff artifact references can bind only an existing workspace");
    if (input.handoffReference.workspaceId !== workspaceId) throw new Error("Handoff artifact workspace identity does not match the explicit selection");
    if (!lifecycle.validateHandoffReference) throw new Error("Target adapter cannot validate the handoff artifact reference");
    const validation = lifecycle.validateHandoffReference({ projectRoot: input.projectRoot, profileId: input.profile.id, reference: input.handoffReference, workspace: resolution, hashes });
    if (validation.state !== "valid") throw new Error(`Handoff artifact reference is ${validation.state}: ${boundedText(validation.reason, "Handoff validation reason", 2_048)}`);
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    contractVersion: ARTIFACT_CONTRACT_VERSION,
    adapterId: input.adapter.id,
    adapterVersion: input.adapter.version,
    profileId: input.profile.id,
    profileVersion: input.profile.version,
    binding: input.configuredBinding,
    selection: input.selection.mode,
    workspace: Object.freeze({ id: workspaceId, kind: "physical" as const }),
    path: resolution.path,
    workspaceHash: hashes.workspaceHash,
    writerLease: Object.freeze({ required: true as const }),
    checkpointIds: Object.freeze([...input.profile.checkpointIds]),
    actionIds: Object.freeze(input.profile.actions.map((action) => action.id)),
  });
}

export interface ListPhysicalArtifactWorkspacesInput {
  readonly projectRoot: string;
  readonly adapter: ArtifactAdapter;
  readonly profile: ArtifactRuntimeProfile;
  readonly options?: Readonly<Record<string, JsonValue>>;
  readonly limit: number;
  readonly cursor?: string;
}
function listItem(value: unknown): ArtifactWorkspaceListItem {
  if (!plainRecord(value) || Object.keys(value).some((key) => !["id", "label", "summary"].includes(key))) throw new Error("Artifact workspace list item is invalid");
  const id = contractId(value.id, "Artifact workspace list ID");
  const label = boundedText(value.label, "Artifact workspace list label", 2_048);
  const summary = value.summary === undefined ? undefined : boundedText(value.summary, "Artifact workspace list summary", 8_192);
  return Object.freeze({ id, label, ...(summary === undefined ? {} : { summary }) });
}
/** Return only bounded disambiguation metadata. Canonical paths never cross this boundary. */
export function listPhysicalArtifactWorkspaces(input: ListPhysicalArtifactWorkspacesInput): ArtifactWorkspaceListPage {
  validateIdentity(input.adapter, input.profile);
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > ARTIFACT_WORKSPACE_LIMITS.listPage) throw new Error("Artifact workspace list limit is invalid");
  const options = input.options ?? Object.freeze({});
  const requestedCursor = cursor(input.cursor);
  const raw = requireLifecycle(input.adapter).list({ projectRoot: input.projectRoot, profileId: input.profile.id, options, limit: input.limit, ...(requestedCursor ? { cursor: requestedCursor } : {}) });
  if (!plainRecord(raw) || Object.keys(raw).some((key) => key !== "items" && key !== "nextCursor") || !Array.isArray(raw.items)
    || raw.items.length > input.limit || raw.items.length > ARTIFACT_WORKSPACE_LIMITS.listItems) throw new Error("Artifact workspace list page is invalid or exceeds its bound");
  const items = Object.freeze(raw.items.map(listItem));
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error("Artifact workspace list contains duplicate stable IDs");
  const nextCursor = cursor(raw.nextCursor);
  const result = Object.freeze({ items, ...(nextCursor ? { nextCursor } : {}) });
  boundedJson(result, "Artifact workspace list page", { bytes: ARTIFACT_WORKSPACE_LIMITS.listBytes, depth: 8, nodes: 1_024 });
  return result;
}

export type WorkspaceLeaseSummary =
  | Readonly<{ state: "available" }>
  | Readonly<{ state: "owned" | "conflict"; runId?: string; heartbeatAt?: string; expiresAt?: string }>;
export interface ArtifactWorkspaceLifecycleDtoV1 {
  readonly schemaVersion: 1;
  readonly adapter: Readonly<{ id: string; version: string; profile: string }>;
  readonly binding: ArtifactBinding;
  readonly workspace: Readonly<{ id: string; kind: "logical-empty" | "physical"; selection?: ArtifactWorkspaceSelection }>;
  readonly currentHash?: string;
  readonly lease: WorkspaceLeaseSummary;
}
export function workspaceLifecycleDto(input: { binding: ArtifactWorkspaceBinding; hashes?: ArtifactWorkspaceHashesV1; lease: WorkspaceLeaseSummary }): ArtifactWorkspaceLifecycleDtoV1 {
  const dto: ArtifactWorkspaceLifecycleDtoV1 = Object.freeze({
    schemaVersion: 1,
    adapter: Object.freeze({ id: input.binding.adapterId, version: input.binding.adapterVersion, profile: input.binding.profileId }),
    binding: input.binding.binding,
    workspace: Object.freeze({ id: input.binding.workspace.id, kind: input.binding.workspace.kind, ...(input.binding.selection ? { selection: input.binding.selection } : {}) }),
    ...(input.hashes ? { currentHash: input.hashes.workspaceHash } : {}),
    lease: Object.freeze({ ...input.lease }),
  });
  boundedJson(dto, "Artifact workspace lifecycle DTO", { bytes: ARTIFACT_WORKSPACE_LIMITS.dtoBytes, depth: 8, nodes: 128 });
  return dto;
}
