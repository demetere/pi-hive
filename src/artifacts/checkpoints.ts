import { createHash } from "node:crypto";
import { posix } from "node:path";
import { canonicalJson } from "../config/snapshot-canonical";
import type { JsonValue } from "../config/types";
import { boundedId, boundedJson, deepFreeze, exactKeys, plainRecord } from "../workflows/values";
import { isArtifactHash, type ArtifactWorkspaceHashesV1 } from "./hashes";

export const CHECKPOINT_DESCRIPTOR_FORMAT_VERSION = 1 as const;
export const CHECKPOINT_DIGEST_LIMITS = Object.freeze({
  contributors: 512,
  dataBytes: 65_536,
  dataDepth: 16,
  dataNodes: 4_096,
  pathBytes: 4_096,
  descriptorBytes: 131_072,
});

export type CheckpointContributorV1 =
  | Readonly<{ kind: "file"; path: string }>
  | Readonly<{ kind: "data"; id: string; value: JsonValue }>
  | Readonly<{ kind: "hash"; id: string; digest: string }>;

export interface CheckpointDescriptorV1 {
  readonly formatVersion: 1;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly profileId: string;
  readonly profileVersion: string;
  /** Adapter-profile schema that defines the contributor contract. */
  readonly profileSchemaVersion: string;
  readonly checkpointId: string;
  readonly checkpointVersion: string;
  readonly contributors: readonly CheckpointContributorV1[];
}

export type ResolvedCheckpointContributorV1 =
  | Readonly<{ kind: "file"; path: string; bytes: number; digest: string }>
  | Readonly<{ kind: "data"; id: string; digest: string }>
  | Readonly<{ kind: "hash"; id: string; digest: string }>;

export interface ResolvedCheckpointDigestV1 {
  readonly formatVersion: 1;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly profileSchemaVersion: string;
  readonly checkpointId: string;
  readonly checkpointVersion: string;
  readonly digest: string;
  /** Redacted contributor proofs: data values are represented only by hashes. */
  readonly contributors: readonly ResolvedCheckpointContributorV1[];
}

export type CheckpointPolicy = "required" | "optional" | "none";
export interface EffectiveCheckpointV1 {
  readonly checkpointId: string;
  readonly policy: CheckpointPolicy;
  readonly enabled: boolean;
}
export interface RunCheckpointSnapshotV1 {
  readonly formatVersion: 1;
  readonly runId: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly profileSchemaVersion: string;
  /** Journal sequence of the last optional-default update observed at creation. */
  readonly defaultsRevision: number;
  readonly checkpoints: readonly EffectiveCheckpointV1[];
  readonly enabledCheckpointIds: readonly string[];
}

function digest(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256").update(`${domain}\0`).update(canonicalJson(value)).digest("hex")}`;
}
function identifier(value: unknown, label: string): string {
  const result = boundedId(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(result)) throw new Error(`${label} is invalid`);
  return result;
}
function contributorPath(value: unknown): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > CHECKPOINT_DIGEST_LIMITS.pathBytes
    || value.includes("\\") || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:\//u.test(value)
    || posix.normalize(value) !== value || value === "." || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Checkpoint contributor path must be a normalized workspace-relative path");
  }
  return value;
}
function validateDescriptorIdentity(value: CheckpointDescriptorV1): Omit<CheckpointDescriptorV1, "contributors"> {
  if (!plainRecord(value)) throw new Error("Checkpoint descriptor is invalid");
  exactKeys(value, ["formatVersion", "adapterId", "adapterVersion", "profileId", "profileVersion", "profileSchemaVersion", "checkpointId", "checkpointVersion", "contributors"], [], "Checkpoint descriptor");
  if (value.formatVersion !== CHECKPOINT_DESCRIPTOR_FORMAT_VERSION || !Array.isArray(value.contributors)
    || value.contributors.length > CHECKPOINT_DIGEST_LIMITS.contributors) throw new Error("Checkpoint descriptor format or contributor count is invalid");
  return Object.freeze({
    formatVersion: CHECKPOINT_DESCRIPTOR_FORMAT_VERSION,
    adapterId: identifier(value.adapterId, "Checkpoint adapter ID"),
    adapterVersion: identifier(value.adapterVersion, "Checkpoint adapter version"),
    profileId: identifier(value.profileId, "Checkpoint profile ID"),
    profileVersion: identifier(value.profileVersion, "Checkpoint profile version"),
    profileSchemaVersion: identifier(value.profileSchemaVersion, "Checkpoint profile schema version"),
    checkpointId: identifier(value.checkpointId, "Checkpoint ID"),
    checkpointVersion: identifier(value.checkpointVersion, "Checkpoint version"),
  });
}
function resolveContributor(value: unknown, hashes: ArtifactWorkspaceHashesV1): ResolvedCheckpointContributorV1 {
  if (!plainRecord(value) || typeof value.kind !== "string") throw new Error("Checkpoint contributor is invalid");
  if (value.kind === "file") {
    exactKeys(value, ["kind", "path"], [], "Checkpoint file contributor");
    const path = contributorPath(value.path);
    const entry = hashes.entries.find((candidate) => candidate.path === path);
    if (!entry || entry.kind !== "file") throw new Error(`Checkpoint file contributor is missing or not a file: ${path}`);
    return Object.freeze({ kind: "file", path, bytes: entry.bytes, digest: entry.hash });
  }
  if (value.kind === "data") {
    exactKeys(value, ["kind", "id", "value"], [], "Checkpoint data contributor");
    const id = identifier(value.id, "Checkpoint data contributor ID");
    const data = boundedJson(value.value, "Checkpoint data contributor", {
      bytes: CHECKPOINT_DIGEST_LIMITS.dataBytes,
      depth: CHECKPOINT_DIGEST_LIMITS.dataDepth,
      nodes: CHECKPOINT_DIGEST_LIMITS.dataNodes,
    });
    return Object.freeze({ kind: "data", id, digest: digest("pi-hive-checkpoint-data-v1", data) });
  }
  if (value.kind === "hash") {
    exactKeys(value, ["kind", "id", "digest"], [], "Checkpoint hash contributor");
    const id = identifier(value.id, "Checkpoint hash contributor ID");
    if (!isArtifactHash(value.digest)) throw new Error("Checkpoint hash contributor digest is invalid");
    return Object.freeze({ kind: "hash", id, digest: value.digest });
  }
  throw new Error("Checkpoint contributor kind is unsupported");
}
function contributorKey(value: ResolvedCheckpointContributorV1): string {
  return `${value.kind}\0${value.kind === "file" ? value.path : value.id}`;
}
function jsonNodeCount(value: JsonValue): number {
  const pending: JsonValue[] = [value];
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    nodes++;
    if (Array.isArray(current)) pending.push(...current);
    else if (current !== null && typeof current === "object") pending.push(...Object.values(current));
  }
  return nodes;
}
function validateAggregateRawDataBounds(descriptor: CheckpointDescriptorV1): void {
  let bytes = 0;
  let nodes = 0;
  for (const contributor of descriptor.contributors) {
    if (!plainRecord(contributor) || contributor.kind !== "data") continue;
    exactKeys(contributor, ["kind", "id", "value"], [], "Checkpoint data contributor");
    identifier(contributor.id, "Checkpoint data contributor ID");
    const data = boundedJson(contributor.value, "Checkpoint data contributor", {
      bytes: CHECKPOINT_DIGEST_LIMITS.dataBytes,
      depth: CHECKPOINT_DIGEST_LIMITS.dataDepth,
      nodes: CHECKPOINT_DIGEST_LIMITS.dataNodes,
    });
    bytes += Buffer.byteLength(canonicalJson(data), "utf8");
    nodes += jsonNodeCount(data);
    if (bytes > CHECKPOINT_DIGEST_LIMITS.dataBytes || nodes > CHECKPOINT_DIGEST_LIMITS.dataNodes) {
      throw new Error("Checkpoint aggregate raw data contributors exceed their byte or node limit");
    }
  }
}
function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Resolve a deterministic exact digest from only the adapter-declared contributors. */
export function resolveCheckpointDigest(descriptor: CheckpointDescriptorV1, hashes: ArtifactWorkspaceHashesV1): ResolvedCheckpointDigestV1 {
  if (hashes.schemaVersion !== 1 || hashes.algorithm !== "sha256" || !isArtifactHash(hashes.workspaceHash) || !Array.isArray(hashes.entries)) {
    throw new Error("Checkpoint workspace hash snapshot is invalid");
  }
  const identity = validateDescriptorIdentity(descriptor);
  validateAggregateRawDataBounds(descriptor);
  const contributors = descriptor.contributors.map((entry) => resolveContributor(entry, hashes))
    .sort((a, b) => compareCanonical(contributorKey(a), contributorKey(b)));
  for (let index = 1; index < contributors.length; index++) {
    if (contributorKey(contributors[index - 1]) === contributorKey(contributors[index])) throw new Error("Checkpoint descriptor contains a duplicate contributor");
  }
  const digestIdentity = { ...identity, contributors };
  if (Buffer.byteLength(canonicalJson(digestIdentity), "utf8") > CHECKPOINT_DIGEST_LIMITS.descriptorBytes) throw new Error("Checkpoint descriptor exceeds its byte limit");
  return deepFreeze({ ...identity, digest: digest("pi-hive-checkpoint-digest-v1", digestIdentity), contributors });
}

export function validateRunCheckpointSnapshot(value: unknown): RunCheckpointSnapshotV1 {
  if (!plainRecord(value)) throw new Error("Run checkpoint snapshot is invalid");
  exactKeys(value, ["formatVersion", "runId", "adapterId", "adapterVersion", "profileId", "profileVersion", "profileSchemaVersion", "defaultsRevision", "checkpoints", "enabledCheckpointIds"], [], "Run checkpoint snapshot");
  if (value.formatVersion !== 1 || !Number.isSafeInteger(value.defaultsRevision) || (value.defaultsRevision as number) < 0
    || !Array.isArray(value.checkpoints) || value.checkpoints.length > CHECKPOINT_DIGEST_LIMITS.contributors
    || !Array.isArray(value.enabledCheckpointIds)) throw new Error("Run checkpoint snapshot format is invalid");
  const checkpoints = value.checkpoints.map((entry): EffectiveCheckpointV1 => {
    if (!plainRecord(entry)) throw new Error("Run checkpoint entry is invalid");
    exactKeys(entry, ["checkpointId", "policy", "enabled"], [], "Run checkpoint entry");
    const checkpointId = identifier(entry.checkpointId, "Run checkpoint ID");
    if (entry.policy !== "required" && entry.policy !== "optional" && entry.policy !== "none") throw new Error("Run checkpoint policy is invalid");
    if (typeof entry.enabled !== "boolean" || (entry.policy === "required" && !entry.enabled) || (entry.policy === "none" && entry.enabled)) throw new Error("Run checkpoint enabled state violates its policy");
    return Object.freeze({ checkpointId, policy: entry.policy, enabled: entry.enabled });
  }).sort((a, b) => compareCanonical(a.checkpointId, b.checkpointId));
  if (new Set(checkpoints.map((entry) => entry.checkpointId)).size !== checkpoints.length) throw new Error("Run checkpoint IDs are duplicated");
  const enabledCheckpointIds = value.enabledCheckpointIds.map((entry) => identifier(entry, "Enabled checkpoint ID"));
  const expectedEnabled = checkpoints.filter((entry) => entry.enabled).map((entry) => entry.checkpointId);
  if (canonicalJson(enabledCheckpointIds) !== canonicalJson(expectedEnabled)) throw new Error("Run enabled checkpoint set does not match its frozen policy");
  return deepFreeze({
    formatVersion: 1,
    runId: identifier(value.runId, "Checkpoint snapshot run ID"),
    adapterId: identifier(value.adapterId, "Checkpoint snapshot adapter ID"),
    adapterVersion: identifier(value.adapterVersion, "Checkpoint snapshot adapter version"),
    profileId: identifier(value.profileId, "Checkpoint snapshot profile ID"),
    profileVersion: identifier(value.profileVersion, "Checkpoint snapshot profile version"),
    profileSchemaVersion: identifier(value.profileSchemaVersion, "Checkpoint snapshot profile schema version"),
    defaultsRevision: value.defaultsRevision as number,
    checkpoints,
    enabledCheckpointIds,
  });
}
