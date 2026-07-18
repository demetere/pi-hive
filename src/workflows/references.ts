import { canonicalJson } from "../config/snapshot-canonical";
import type { JsonValue } from "../config/types";
import { boundedJson, boundedText, plainRecord, utf8Prefix } from "./values";

const LIMITS = Object.freeze({
  references: 128,
  kindBytes: 128,
  idBytes: 2_048,
  diagnosticBytes: 2_048,
  resolvedItemBytes: 65_536,
  resolvedAggregateBytes: 131_072,
  resolvedDepth: 16,
  resolvedNodes: 4_096,
});
const JSON_BOUNDS = {
  bytes: LIMITS.resolvedItemBytes,
  depth: LIMITS.resolvedDepth,
  nodes: LIMITS.resolvedNodes,
} as const;

export const NO_DLP_PROSE_LIMITATION =
  "Capabilities re-authorize structured references; free-form prose is not DLP or information-flow control.";

export interface StructuredReference {
  readonly kind: string;
  readonly id: string;
}

export type ReferenceAuthorizationDecision =
  | Readonly<{ authorized: true; resolved?: JsonValue }>
  | Readonly<{ authorized: false; diagnostic: string }>;

export interface ReferenceAuthorizer {
  authorize(reference: StructuredReference, recipientNodeId: string): ReferenceAuthorizationDecision;
}

export type AuthorizedReference =
  | Readonly<{ ref: StructuredReference; authorization: "authorized"; resolved?: JsonValue }>
  | Readonly<{ ref: StructuredReference; authorization: "denied"; diagnostic: string }>;

export function validateStructuredReference(value: unknown, label = "Reference"): StructuredReference {
  if (!plainRecord(value) || Object.keys(value).some((key) => key !== "kind" && key !== "id")) {
    throw new Error(`${label} has an invalid closed shape`);
  }
  return Object.freeze({
    kind: boundedText(value.kind, `${label} kind`, LIMITS.kindBytes),
    id: boundedText(value.id, `${label} id`, LIMITS.idBytes),
  });
}

function denied(ref: StructuredReference, diagnostic: string): AuthorizedReference {
  return Object.freeze({
    ref,
    authorization: "denied" as const,
    diagnostic: utf8Prefix(diagnostic, LIMITS.diagnosticBytes),
  });
}

function authorizeOne(
  raw: StructuredReference,
  index: number,
  recipientNodeId: string,
  authorizer?: ReferenceAuthorizer,
): AuthorizedReference {
  const ref = validateStructuredReference(raw, `Context reference ${index}`);
  if (!authorizer) return denied(ref, "No reference authorization service is available");
  let decision: ReferenceAuthorizationDecision;
  try {
    decision = authorizer.authorize(ref, recipientNodeId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return denied(ref, `Authorization failed: ${utf8Prefix(message, LIMITS.diagnosticBytes - 22)}`);
  }
  if (!decision?.authorized) {
    const diagnostic = typeof decision?.diagnostic === "string" && decision.diagnostic.trim()
      ? decision.diagnostic
      : "Recipient is not authorized for this reference";
    return denied(ref, diagnostic);
  }
  if (decision.resolved === undefined) return Object.freeze({ ref, authorization: "authorized" as const });
  try {
    return Object.freeze({
      ref,
      authorization: "authorized" as const,
      resolved: boundedJson(decision.resolved, `Resolved context reference ${index}`, JSON_BOUNDS),
    });
  } catch {
    return denied(ref, "Authorized reference content exceeds the recipient context bound");
  }
}

export function authorizeReferences(
  references: readonly StructuredReference[] | undefined,
  recipientNodeId: string,
  authorizer?: ReferenceAuthorizer,
): readonly AuthorizedReference[] {
  if (!references) return Object.freeze([]);
  if (!Array.isArray(references) || references.length > LIMITS.references) {
    throw new Error("Context reference limit exceeded");
  }
  let aggregate = 0;
  return Object.freeze(references.map((raw, index) => {
    const result = authorizeOne(raw, index, recipientNodeId, authorizer);
    if (result.authorization !== "authorized" || result.resolved === undefined) return result;
    aggregate += Buffer.byteLength(canonicalJson(result.resolved), "utf8");
    return aggregate <= LIMITS.resolvedAggregateBytes
      ? result
      : denied(result.ref, "Authorized reference content exceeds the recipient context bound");
  }));
}

export { LIMITS as REFERENCE_AUTHORIZATION_LIMITS };
