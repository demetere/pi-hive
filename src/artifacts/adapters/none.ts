import { Type } from "typebox";
import {
  ARTIFACT_CONTRACT_VERSION,
  ARTIFACT_PROFILE_VERSION,
  ARTIFACT_VIEW_VERSION,
} from "../contracts";
import type {
  ArtifactAdapter,
  ArtifactBindRequest,
  ArtifactRuntimeProfile,
  ArtifactStatusContext,
  ArtifactStatusPageRequest,
  ArtifactWorkspaceBinding,
} from "../types";

export const NONE_ADAPTER_VERSION = "1" as const;
const strict = { additionalProperties: false } as const;

export const NONE_PROFILE: ArtifactRuntimeProfile = Object.freeze({
  contractVersion: ARTIFACT_CONTRACT_VERSION,
  version: ARTIFACT_PROFILE_VERSION,
  adapterId: "none",
  adapterVersion: NONE_ADAPTER_VERSION,
  id: "default",
  optionsSchemaVersion: "1",
  optionsSchema: Type.Object({}, strict),
  bindings: Object.freeze(["none"] as const),
  checkpointIds: Object.freeze([]),
  actions: Object.freeze([]),
  viewVersion: ARTIFACT_VIEW_VERSION,
});

function noneBinding(): ArtifactWorkspaceBinding {
  return Object.freeze({
    schemaVersion: 1 as const,
    contractVersion: ARTIFACT_CONTRACT_VERSION,
    adapterId: "none",
    adapterVersion: NONE_ADAPTER_VERSION,
    profileId: "default",
    profileVersion: ARTIFACT_PROFILE_VERSION,
    binding: "none" as const,
    workspace: Object.freeze({ id: "none", kind: "logical-empty" as const }),
    checkpointIds: Object.freeze([]),
    actionIds: Object.freeze([]),
  });
}

function requireNoneBinding(binding: ArtifactWorkspaceBinding): void {
  if (binding.contractVersion !== ARTIFACT_CONTRACT_VERSION || binding.adapterId !== "none" || binding.adapterVersion !== NONE_ADAPTER_VERSION
    || binding.profileId !== "default" || binding.profileVersion !== ARTIFACT_PROFILE_VERSION || binding.binding !== "none"
    || binding.workspace.id !== "none" || binding.workspace.kind !== "logical-empty" || binding.path !== undefined
    || binding.workspaceHash !== undefined || binding.writerLease !== undefined || binding.checkpointIds.length || binding.actionIds.length) {
    throw new Error("none adapter received an incompatible workspace binding");
  }
}

export const NONE_ARTIFACT_ADAPTER: ArtifactAdapter = Object.freeze({
  contractVersion: ARTIFACT_CONTRACT_VERSION,
  id: "none",
  version: NONE_ADAPTER_VERSION,
  profiles: Object.freeze([NONE_PROFILE]),
  bind(profile: ArtifactRuntimeProfile, request: ArtifactBindRequest) {
    if (profile !== NONE_PROFILE || request.binding !== "none") throw new Error("none/default supports only the none binding");
    if (Object.keys(request.options).length) throw new Error("none/default options contain unknown fields");
    return noneBinding();
  },
  status(context: ArtifactStatusContext, page: ArtifactStatusPageRequest) {
    requireNoneBinding(context.binding);
    return Object.freeze({
      schemaVersion: ARTIFACT_VIEW_VERSION,
      contractVersion: ARTIFACT_CONTRACT_VERSION,
      adapter: Object.freeze({ id: "none", version: NONE_ADAPTER_VERSION }),
      profile: Object.freeze({ id: "default", version: ARTIFACT_PROFILE_VERSION }),
      workspace: Object.freeze({ id: "none", kind: "logical-empty" as const, binding: "none" as const }),
      status: "complete" as const,
      summary: "No artifact workspace is configured for this run.",
      checkpoints: Object.freeze([]),
      actions: Object.freeze([]),
      items: Object.freeze([]),
      page: Object.freeze({ limit: page.limit, ...(page.cursor ? { cursor: page.cursor } : {}) }),
      refs: Object.freeze([]),
    });
  },
  reconcileAction() {
    return Object.freeze({ state: "unknown" as const, diagnostic: "none adapter has no mutating actions" });
  },
  validateCompletion(binding: ArtifactWorkspaceBinding) {
    requireNoneBinding(binding);
    return Object.freeze({ state: "satisfied" as const });
  },
});
