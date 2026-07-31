import type { ArtifactCapability } from "../../capabilities/types";
import { classifyTrustedTool } from "../../capabilities/tools";
import type { ActivationSnapshotFileV1 } from "../../config/snapshot";
import { plainRecord } from "../../workflows/values";
import type { ArtifactWorkspaceBinding } from "../types";

const ARTIFACT_CALLER_BRAND: unique symbol = Symbol("pi-hive-artifact-caller");
const ISSUED_CALLERS = new WeakSet<object>();

/** Package-internal opaque caller proof. It is issued only into an active orchestration service closure. */
export interface PackageArtifactCallerContext {
  readonly [ARTIFACT_CALLER_BRAND]: true;
  readonly nodeId: string;
  readonly capabilities: readonly ArtifactCapability[];
  readonly tools: readonly string[];
  readonly workspace: ArtifactWorkspaceBinding;
}

export interface RunOrchestrationArtifactCallerIssuer {
  issue(nodeId: string, workspace: ArtifactWorkspaceBinding): PackageArtifactCallerContext;
  revoke(): void;
}

function artifactCapabilities(value: unknown): readonly ArtifactCapability[] {
  if (!plainRecord(value)) return Object.freeze([]);
  const effective = plainRecord(value.effective) ? value.effective : value;
  const raw = effective.artifact;
  if (!Array.isArray(raw) || raw.some((item) => item !== "read" && item !== "write" && item !== "review")) return Object.freeze([]);
  return Object.freeze([...new Set(raw as ArtifactCapability[])].sort());
}

/** Package-internal issuance boundary. The returned issuer is held privately by RunOrchestrationService. */
export function createRunOrchestrationArtifactCallerIssuer(snapshot: ActivationSnapshotFileV1): RunOrchestrationArtifactCallerIssuer {
  let active = true;
  return Object.freeze({
    issue(nodeId: string, workspace: ArtifactWorkspaceBinding): PackageArtifactCallerContext {
      if (!active) throw new Error("Artifact caller authority is no longer active");
      const authority = snapshot.payload.authority.nodes.find((entry) => entry.nodeId === nodeId);
      if (!authority || !plainRecord(authority.capabilities) || !Array.isArray(authority.tools)
        || authority.tools.some((tool) => typeof tool !== "string" || !classifyTrustedTool(tool))) {
        throw new Error(`Artifact caller ${nodeId} is absent from immutable trusted authority`);
      }
      const caller = Object.freeze({
        [ARTIFACT_CALLER_BRAND]: true as const,
        nodeId,
        capabilities: artifactCapabilities(authority.capabilities),
        tools: Object.freeze([...authority.tools]),
        workspace,
      });
      ISSUED_CALLERS.add(caller);
      return caller;
    },
    revoke(): void { active = false; },
  });
}

export function isPackageArtifactCaller(value: unknown): value is PackageArtifactCallerContext {
  return Boolean(value) && typeof value === "object" && ISSUED_CALLERS.has(value as object);
}
