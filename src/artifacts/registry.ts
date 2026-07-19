import { Type } from "typebox";
import { Value } from "typebox/value";
import { boundedJson } from "../workflows/values";
import {
  ARTIFACT_CONTRACT_LIMITS,
  ARTIFACT_CONTRACT_VERSION,
  ARTIFACT_PROFILE_VERSION,
  ARTIFACT_VIEW_VERSION,
  BUILTIN_ARTIFACT_PROFILES,
  type ArtifactBinding,
} from "./contracts";
import { NONE_ARTIFACT_ADAPTER, NONE_PROFILE } from "./adapters/none";
import type {
  ArtifactAdapter,
  ArtifactBindRequest,
  ArtifactRuntimeProfile,
  ArtifactWorkspaceBinding,
} from "./types";

export type ArtifactRegistryErrorCode =
  | "CONTRACT_VERSION_UNKNOWN"
  | "ADAPTER_UNKNOWN"
  | "ADAPTER_VERSION_UNKNOWN"
  | "PROFILE_UNKNOWN"
  | "PROFILE_VERSION_UNKNOWN"
  | "ADAPTER_UNAVAILABLE"
  | "OPTIONS_INVALID"
  | "BINDING_INVALID";

export class ArtifactRegistryError extends Error {
  readonly code: ArtifactRegistryErrorCode;
  constructor(code: ArtifactRegistryErrorCode, message: string) {
    super(message);
    this.name = "ArtifactRegistryError";
    this.code = code;
  }
}

export interface ArtifactProfileSelection {
  readonly contractVersion: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly profileId: string;
  readonly profileVersion: string;
}
export interface ResolvedArtifactProfile {
  readonly profile: ArtifactRuntimeProfile;
  readonly adapter: ArtifactAdapter;
}

const strict = { additionalProperties: false } as const;
const EMPTY_OPTIONS = Type.Object({}, strict);
const runtimeProfiles: readonly ArtifactRuntimeProfile[] = Object.freeze(BUILTIN_ARTIFACT_PROFILES.map((metadata) => {
  if (metadata.adapter === "none" && metadata.profile === "default") return NONE_PROFILE;
  return Object.freeze({
    contractVersion: ARTIFACT_CONTRACT_VERSION,
    version: ARTIFACT_PROFILE_VERSION,
    adapterId: metadata.adapter,
    adapterVersion: metadata.adapterVersion,
    id: metadata.profile,
    optionsSchemaVersion: "1" as const,
    optionsSchema: EMPTY_OPTIONS,
    bindings: metadata.bindings,
    checkpointIds: metadata.checkpoints,
    actions: Object.freeze([]),
    viewVersion: ARTIFACT_VIEW_VERSION,
  });
}));

class BuiltinArtifactRegistry {
  readonly contractVersion = ARTIFACT_CONTRACT_VERSION;
  private readonly profiles = runtimeProfiles;

  private implementation(adapterId: string): ArtifactAdapter | undefined {
    return adapterId === "none" ? NONE_ARTIFACT_ADAPTER : undefined;
  }

  adapterIds(): readonly string[] {
    return Object.freeze([...new Set(this.profiles.map((profile) => profile.adapterId))].sort());
  }

  resolveProfile(selection: ArtifactProfileSelection): ResolvedArtifactProfile {
    if (selection.contractVersion !== ARTIFACT_CONTRACT_VERSION) throw new ArtifactRegistryError("CONTRACT_VERSION_UNKNOWN", `Unknown artifact contract version ${selection.contractVersion}`);
    const adapterProfiles = this.profiles.filter((profile) => profile.adapterId === selection.adapterId);
    if (!adapterProfiles.length) throw new ArtifactRegistryError("ADAPTER_UNKNOWN", `Unknown built-in artifact adapter ${selection.adapterId}`);
    if (!adapterProfiles.some((profile) => profile.adapterVersion === selection.adapterVersion)) throw new ArtifactRegistryError("ADAPTER_VERSION_UNKNOWN", `Unknown version ${selection.adapterVersion} for artifact adapter ${selection.adapterId}`);
    const profile = adapterProfiles.find((candidate) => candidate.adapterVersion === selection.adapterVersion && candidate.id === selection.profileId);
    if (!profile) throw new ArtifactRegistryError("PROFILE_UNKNOWN", `Unknown profile ${selection.profileId} for artifact adapter ${selection.adapterId}`);
    if (profile.version !== selection.profileVersion) throw new ArtifactRegistryError("PROFILE_VERSION_UNKNOWN", `Unknown version ${selection.profileVersion} for artifact profile ${selection.adapterId}/${selection.profileId}`);
    const adapter = this.implementation(selection.adapterId);
    if (!adapter) throw new ArtifactRegistryError("ADAPTER_UNAVAILABLE", `Built-in adapter ${selection.adapterId} is reserved for a future package implementation`);
    return Object.freeze({ profile, adapter });
  }

  validateOptions(profile: ArtifactRuntimeProfile, raw: unknown): Readonly<Record<string, never>> {
    try {
      boundedJson(raw, "Artifact options", {
        bytes: ARTIFACT_CONTRACT_LIMITS.optionsBytes,
        depth: ARTIFACT_CONTRACT_LIMITS.jsonDepth,
        nodes: ARTIFACT_CONTRACT_LIMITS.jsonNodes,
        rootRecord: true,
      });
    } catch (error) {
      throw new ArtifactRegistryError("OPTIONS_INVALID", String(error instanceof Error ? error.message : error));
    }
    if (!Value.Check(profile.optionsSchema, raw)) throw new ArtifactRegistryError("OPTIONS_INVALID", `Artifact options for ${profile.adapterId}/${profile.id} contain unknown or invalid fields`);
    return Object.freeze({});
  }

  bind(resolved: ResolvedArtifactProfile, request: { readonly runId: string; readonly binding: string; readonly options: unknown }): ArtifactWorkspaceBinding {
    if (!resolved.profile.bindings.includes(request.binding as ArtifactBinding)) throw new ArtifactRegistryError("BINDING_INVALID", `Binding ${request.binding} is not supported by ${resolved.profile.adapterId}/${resolved.profile.id}`);
    const options = this.validateOptions(resolved.profile, request.options);
    const input: ArtifactBindRequest = Object.freeze({ runId: request.runId, binding: request.binding as ArtifactBinding, options });
    return resolved.adapter.bind(resolved.profile, input);
  }
}

/** Package-constructed registry. It intentionally has no registration or config-loading API. */
export const BUILTIN_ARTIFACT_REGISTRY = Object.freeze(new BuiltinArtifactRegistry());
