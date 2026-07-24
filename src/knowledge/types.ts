import type { JsonValue } from "../config/types";

export const KNOWLEDGE_IDENTITY_LIMITS = Object.freeze({
  bundleIdBytes: 256,
  documentIdBytes: 1_716,
  readRefBytes: 2_048,
});

export function validKnowledgeBundleId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value)
    && Buffer.byteLength(value, "utf8") <= KNOWLEDGE_IDENTITY_LIMITS.bundleIdBytes;
}

export function validKnowledgeDocumentId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && Buffer.byteLength(value, "utf8") <= KNOWLEDGE_IDENTITY_LIMITS.documentIdBytes
    && !value.startsWith("/") && !value.includes("\\")
    && value.split("/").every((part) => part && part !== "." && part !== ".."
      && ![...part].some((character) => character === "\0" || character.codePointAt(0)! < 0x20));
}

export function knowledgeReadRef(bundleId: string, documentId: string, contentHash: string): string {
  if (!validKnowledgeBundleId(bundleId) || !validKnowledgeDocumentId(documentId) || !/^[0-9a-f]{64}$/u.test(contentHash)) {
    throw new Error("Knowledge read reference identity is invalid");
  }
  const reference = `knowledge:${bundleId}/${documentId}@${contentHash}`;
  if (Buffer.byteLength(reference, "utf8") > KNOWLEDGE_IDENTITY_LIMITS.readRefBytes) throw new Error("Knowledge read reference exceeds its transport bound");
  return reference;
}

export type KnowledgeUpdatePolicy = "automatic" | "reviewed" | "read-only";
export type KnowledgeDiagnosticSeverity = "error" | "warning";

export interface KnowledgeDiagnostic {
  readonly code: string;
  readonly severity: KnowledgeDiagnosticSeverity;
  readonly message: string;
  readonly bundleId: string;
  readonly documentId?: string;
}

export interface KnowledgeBundleDeclaration {
  readonly id: string;
  readonly providerId: string;
  readonly path: string;
  readonly ownerAgentId?: string;
  readonly updatePolicy: KnowledgeUpdatePolicy;
}

export interface KnowledgeLink {
  readonly kind: "internal" | "external";
  /** Provider-neutral document ID for internal links or an opaque external URI. */
  readonly target: string;
  readonly exists?: boolean;
}

export interface KnowledgeDocument {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly body: string;
  /** Exact decoded source. contentHash is over these exact UTF-8 bytes. */
  readonly content: string;
  readonly contentHash: string;
  readonly bytes: number;
  readonly links: readonly KnowledgeLink[];
}

export interface KnowledgeBundle {
  readonly id: string;
  readonly providerId: string;
  readonly ownerAgentId?: string;
  readonly updatePolicy: KnowledgeUpdatePolicy;
  /** Harness-only canonical root; never include it in agent-facing results. */
  readonly canonicalRoot: string;
  readonly documents: readonly KnowledgeDocument[];
  readonly summary: string;
  readonly contentHash: string;
  readonly totalBytes: number;
  readonly diagnostics: readonly KnowledgeDiagnostic[];
}

export interface KnowledgeBundleLoadRequest {
  readonly projectRoot: string;
  readonly declaration: KnowledgeBundleDeclaration;
  /** Shared catalog accounting hook. Providers reserve exact file bytes before reading content. */
  readonly reserveContentBytes?: (bytes: number) => void;
}

export interface KnowledgeBundleLoadResult {
  readonly ok: boolean;
  readonly bundle?: KnowledgeBundle;
  readonly diagnostics: readonly KnowledgeDiagnostic[];
}

export interface KnowledgeProvider {
  readonly id: string;
  readonly version: string;
  load(request: KnowledgeBundleLoadRequest): KnowledgeBundleLoadResult;
}

export interface KnowledgeSearchResult {
  readonly bundleId: string;
  readonly documentId: string;
  readonly title: string;
  readonly description?: string;
  readonly score: number;
  readonly snippet: string;
  readonly bundleContentHash: string;
  readonly contentHash: string;
  readonly returnedContentHash: string;
  readonly readRef: string;
}

export interface KnowledgeSearchPage {
  readonly query: string;
  readonly total: number;
  readonly items: readonly KnowledgeSearchResult[];
  readonly bundles: readonly Readonly<{ bundleId: string; contentHash: string }>[];
  readonly indexHash: string;
  readonly nextCursor?: string;
}

export interface KnowledgeReadPage {
  readonly bundleId: string;
  readonly documentId: string;
  readonly title: string;
  readonly content: string;
  readonly bundleContentHash: string;
  readonly contentHash: string;
  readonly returnedContentHash: string;
  readonly totalBytes: number;
  readonly returnedBytes: number;
  readonly nextCursor?: string;
  readonly readRef: string;
}

export type KnowledgeProvenanceValue = JsonValue;
