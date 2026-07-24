import type { ActivationSnapshotFileV1 } from "../config/snapshot";
import type { JsonValue } from "../config/types";
import type { ReferenceAuthorizer, ReferenceAuthorizationDecision, StructuredReference } from "../workflows/references";
import type { ProtectedPathRoot } from "../capabilities/reserved-paths";

function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function authorityKnowledge(snapshot: ActivationSnapshotFileV1, nodeId: string): readonly string[] {
  const authority = snapshot.payload.authority.nodes.find((entry) => entry.nodeId === nodeId);
  if (!record(authority?.capabilities)) return [];
  const attachments = record(authority.capabilities.attachments) ? authority.capabilities.attachments : undefined;
  return Array.isArray(attachments?.knowledge) && attachments.knowledge.every((entry) => typeof entry === "string") ? attachments.knowledge : [];
}

export function knowledgeProtectedPathRoots(snapshot: ActivationSnapshotFileV1): readonly ProtectedPathRoot[] {
  const paths = new Set<string>();
  for (const entry of snapshot.payload.knowledge) if (typeof entry.path === "string" && entry.path && !entry.path.startsWith("/") && !entry.path.includes("\\")) paths.add(entry.path);
  return Object.freeze([...paths].sort(compare).map((path) => Object.freeze({ path, kind: "knowledge" as const })));
}

/** Runtime attachment authority comes only from the rederived frozen authority list. */
export function attachedKnowledgeBundleIds(snapshot: ActivationSnapshotFileV1, nodeId: string): readonly string[] {
  if (!snapshot.payload.authority.nodes.some((entry) => entry.nodeId === nodeId)) return Object.freeze([]);
  const available = new Set(snapshot.payload.knowledge.flatMap((entry) => typeof entry.id === "string" ? [entry.id] : []));
  return Object.freeze([...new Set(authorityKnowledge(snapshot, nodeId).filter((id) => available.has(id)))].sort(compare));
}

export function nodeHasKnowledgeRead(snapshot: ActivationSnapshotFileV1, nodeId: string): boolean {
  const authority = snapshot.payload.authority.nodes.find((entry) => entry.nodeId === nodeId);
  if (!record(authority?.capabilities)) return false;
  const effective = record(authority.capabilities.effective) ? authority.capabilities.effective : undefined;
  return Array.isArray(effective?.knowledge) && effective.knowledge.includes("read")
    && Array.isArray(authority.tools) && authority.tools.includes("knowledge_search") && authority.tools.includes("knowledge_read");
}

export interface KnowledgeReferenceInspector {
  inspectReference(nodeId: string, bundleId: string, documentId: string, expectedHash?: string): Readonly<Record<string, JsonValue>>;
}

function denied(message: string): ReferenceAuthorizationDecision {
  return Object.freeze({ authorized: false as const, diagnostic: message.slice(0, 2_048) });
}

export function createKnowledgeReferenceAuthorizer(
  snapshot: ActivationSnapshotFileV1,
  inspector: KnowledgeReferenceInspector,
  fallback?: ReferenceAuthorizer,
): ReferenceAuthorizer {
  return Object.freeze({
    authorize(reference: StructuredReference, recipientNodeId: string): ReferenceAuthorizationDecision {
      if (reference.kind !== "knowledge") return fallback?.authorize(reference, recipientNodeId) ?? denied("No reference authorization service is available");
      if (!nodeHasKnowledgeRead(snapshot, recipientNodeId)) return denied("Recipient knowledge.read authority is denied");
      const separator = reference.id.indexOf("/");
      if (separator <= 0 || separator === reference.id.length - 1) return denied("Knowledge reference identity is invalid");
      const bundleId = reference.id.slice(0, separator);
      const documentAndHash = reference.id.slice(separator + 1);
      const hashSeparator = documentAndHash.lastIndexOf("@");
      const hashCandidate = hashSeparator > 0 ? documentAndHash.slice(hashSeparator + 1) : "";
      const hasHash = /^(?:sha256:)?[0-9a-f]{64}$/u.test(hashCandidate);
      const documentId = hasHash ? documentAndHash.slice(0, hashSeparator) : documentAndHash;
      const expectedHash = hasHash ? hashCandidate : undefined;
      if (!attachedKnowledgeBundleIds(snapshot, recipientNodeId).includes(bundleId)) return denied("Knowledge bundle is not attached to the recipient");
      try {
        return Object.freeze({ authorized: true as const, resolved: inspector.inspectReference(recipientNodeId, bundleId, documentId, expectedHash) as JsonValue });
      } catch {
        return denied("Knowledge reference is unavailable or stale for the recipient");
      }
    },
  });
}
