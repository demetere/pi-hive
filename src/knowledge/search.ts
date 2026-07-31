import { createHash } from "node:crypto";
import type { ActivationSnapshotFileV1 } from "../config/snapshot";
import { canonicalJson } from "../config/snapshot-canonical";
import type { JsonValue } from "../config/types";
import { createWorkflowEvent } from "../workflows/events";
import { appendWorkflowEvent } from "../workflows/journal";
import type { DynamicPromptInput } from "../workflows/prompts";
import { attachedKnowledgeBundleIds, nodeHasKnowledgeRead, type KnowledgeReferenceInspector } from "./attachments";
import { buildKnowledgeLexicalIndex, KNOWLEDGE_INDEX_LIMITS, searchKnowledgeLexicalIndex, tokenizeKnowledgeText } from "./index";
import { createBuiltInKnowledgeProviderRegistry, KnowledgeProviderRegistry } from "./provider";
import {
  knowledgeReadRef,
  validKnowledgeBundleId,
  validKnowledgeDocumentId,
  type KnowledgeBundle,
  type KnowledgeReadPage,
  type KnowledgeSearchPage,
  type KnowledgeSearchResult,
} from "./types";

export const KNOWLEDGE_SEARCH_LIMITS = Object.freeze({
  queryBytes: 4_096,
  queryTokens: 64,
  requestedBundles: 128,
  pageSize: 40,
  cursorBytes: 2_048,
  readPageBytes: 32_768,
  readPageOutputBytes: 60_000,
  promptBundles: 128,
  promptDocumentsPerBundle: 256,
  promptSummaryBytes: 16_384,
  searchPageBytes: 60_000,
  searchTitleJsonBytes: 2_048,
  searchDescriptionJsonBytes: 4_096,
  searchSnippetJsonBytes: 4_096,
  compactSearchFieldJsonBytes: 256,
});

interface SearchRequest { readonly query: string; readonly bundleIds?: readonly string[]; readonly limit?: number; readonly cursor?: string }
interface ReadRequest { readonly bundleId: string; readonly documentId: string; readonly cursor?: string }
export interface KnowledgeServiceOptions {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly snapshot: ActivationSnapshotFileV1;
  readonly providers?: KnowledgeProviderRegistry;
  readonly now?: () => string;
}

function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function tagged(hash: string): string { return `sha256:${hash}`; }
function utf8Prefix(value: string, bytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= bytes) return value;
  let output = "";
  let used = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > bytes) break;
    output += character;
    used += size;
  }
  return output;
}
function jsonStringPrefix(value: string, bytes: number): string {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") <= bytes) return value;
  let output = "";
  let used = 2;
  for (const character of value) {
    const size = Buffer.byteLength(JSON.stringify(character), "utf8") - 2;
    if (used + size > bytes) break;
    output += character;
    used += size;
  }
  return output;
}
function projectedSearchResult(result: KnowledgeSearchResult, compact = false): KnowledgeSearchResult {
  if (!validKnowledgeBundleId(result.bundleId) || !validKnowledgeDocumentId(result.documentId)
    || !/^sha256:[0-9a-f]{64}$/u.test(result.bundleContentHash) || !/^sha256:[0-9a-f]{64}$/u.test(result.contentHash)) {
    throw new Error("Knowledge provider returned an invalid search identity or hash");
  }
  const readRef = knowledgeReadRef(result.bundleId, result.documentId, result.contentHash.slice("sha256:".length));
  if (result.readRef !== readRef) throw new Error("Knowledge provider returned inconsistent search provenance");
  const fieldBytes = compact ? KNOWLEDGE_SEARCH_LIMITS.compactSearchFieldJsonBytes : undefined;
  const title = jsonStringPrefix(result.title, fieldBytes ?? KNOWLEDGE_SEARCH_LIMITS.searchTitleJsonBytes);
  const snippet = jsonStringPrefix(result.snippet, fieldBytes ?? KNOWLEDGE_SEARCH_LIMITS.searchSnippetJsonBytes);
  const description = compact || result.description === undefined
    ? undefined
    : jsonStringPrefix(result.description, KNOWLEDGE_SEARCH_LIMITS.searchDescriptionJsonBytes);
  return Object.freeze({
    bundleId: result.bundleId,
    documentId: result.documentId,
    title,
    ...(description !== undefined ? { description } : {}),
    score: result.score,
    snippet,
    bundleContentHash: result.bundleContentHash,
    contentHash: result.contentHash,
    returnedContentHash: tagged(sha256(snippet)),
    readRef,
  });
}
function encodeCursor(value: Readonly<Record<string, unknown>>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
function decodeCursor(cursor: string | undefined): Record<string, unknown> | undefined {
  if (cursor === undefined) return undefined;
  if (!cursor || Buffer.byteLength(cursor, "utf8") > KNOWLEDGE_SEARCH_LIMITS.cursorBytes || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new Error("Knowledge cursor is invalid");
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("shape");
    return decoded as Record<string, unknown>;
  } catch { throw new Error("Knowledge cursor is invalid"); }
}
function pageSize(value: number | undefined): number {
  if (value === undefined) return 20;
  if (!Number.isSafeInteger(value) || value < 1 || value > KNOWLEDGE_SEARCH_LIMITS.pageSize) throw new Error("Knowledge page limit is invalid");
  return value;
}

export class KnowledgeService implements KnowledgeReferenceInspector {
  readonly options: KnowledgeServiceOptions;
  private readonly providers: KnowledgeProviderRegistry;

  constructor(options: KnowledgeServiceOptions) {
    this.options = options;
    this.providers = options.providers ?? createBuiltInKnowledgeProviderRegistry();
  }

  private assertRead(nodeId: string): readonly string[] {
    if (!nodeHasKnowledgeRead(this.options.snapshot, nodeId)) throw new Error("Policy denied knowledge.read for this node");
    const attached = attachedKnowledgeBundleIds(this.options.snapshot, nodeId);
    if (!attached.length) throw new Error("Policy denied knowledge access because no bundle is attached");
    return attached;
  }

  private declaration(bundleId: string) {
    const raw = this.options.snapshot.payload.knowledge.find((entry) => entry.id === bundleId);
    if (!raw || raw.provider !== "okf" || typeof raw.path !== "string" || (raw.owner !== undefined && typeof raw.owner !== "string")
      || (raw.updates !== "automatic" && raw.updates !== "reviewed" && raw.updates !== "read-only")) throw new Error("Attached knowledge bundle is unavailable");
    return Object.freeze({
      id: bundleId,
      providerId: raw.provider,
      path: raw.path,
      ...(raw.owner ? { ownerAgentId: raw.owner } : {}),
      updatePolicy: raw.updates,
    });
  }

  private loadBundle(bundleId: string, reserveContentBytes?: (bytes: number) => void): KnowledgeBundle {
    const loaded = this.providers.load({ projectRoot: this.options.projectRoot, declaration: this.declaration(bundleId), ...(reserveContentBytes ? { reserveContentBytes } : {}) });
    if (!loaded.ok || !loaded.bundle) {
      const codes = loaded.diagnostics.slice(0, 8).map((diagnostic) => diagnostic.code).join(",");
      throw new Error(`Attached knowledge bundle failed validation${codes ? ` (${codes})` : ""}`);
    }
    return loaded.bundle;
  }

  private selectedBundles(nodeId: string, requested?: readonly string[]): readonly KnowledgeBundle[] {
    const attached = this.assertRead(nodeId);
    const selected = requested === undefined ? attached : (() => {
      if (!Array.isArray(requested) || requested.length > KNOWLEDGE_SEARCH_LIMITS.requestedBundles || new Set(requested).size !== requested.length || requested.some((id) => !validKnowledgeBundleId(id))) throw new Error("Knowledge bundle filter is invalid");
      if (requested.some((id) => !attached.includes(id))) throw new Error("Knowledge bundle is not attached to this node");
      return [...requested].sort(compare);
    })();
    let consumed = 0;
    let exhausted = false;
    const reserveContentBytes = (bytes: number): void => {
      if (exhausted || !Number.isSafeInteger(bytes) || bytes < 0 || consumed + bytes > KNOWLEDGE_INDEX_LIMITS.aggregateBytes) {
        exhausted = true;
        throw new Error("Knowledge operation aggregate byte limit exceeded before content read");
      }
      consumed += bytes;
    };
    return Object.freeze(selected.map((id) => this.loadBundle(id, reserveContentBytes)));
  }

  search(nodeId: string, request: SearchRequest, attemptId?: string): KnowledgeSearchPage {
    if (!request || typeof request.query !== "string" || !request.query.trim() || Buffer.byteLength(request.query, "utf8") > KNOWLEDGE_SEARCH_LIMITS.queryBytes) throw new Error("Knowledge search query exceeds its UTF-8 byte limit");
    const query = request.query.normalize("NFKC").trim();
    const queryTokens = tokenizeKnowledgeText(query, KNOWLEDGE_SEARCH_LIMITS.queryTokens + 1);
    if (!queryTokens.length || queryTokens.length > KNOWLEDGE_SEARCH_LIMITS.queryTokens) throw new Error("Knowledge search query token limit exceeded");
    const bundles = this.selectedBundles(nodeId, request.bundleIds);
    const index = buildKnowledgeLexicalIndex(bundles);
    const results = searchKnowledgeLexicalIndex(index, query);
    const cursor = decodeCursor(request.cursor);
    const queryHash = sha256(query);
    let offset = 0;
    if (cursor) {
      if (cursor.v !== 1 || cursor.q !== queryHash || cursor.i !== index.indexHash || !Number.isSafeInteger(cursor.o) || Number(cursor.o) < 0) throw new Error("Knowledge search cursor is stale or invalid");
      offset = Number(cursor.o);
    }
    if (offset > results.length) throw new Error("Knowledge search cursor is out of range");
    const limit = pageSize(request.limit);
    let selected = results.slice(offset, offset + limit).map((result) => projectedSearchResult(result));
    const indexInputBundles = Object.freeze(bundles.map((bundle) => Object.freeze({ bundleId: bundle.id, contentHash: tagged(bundle.contentHash) })));
    const bundleViewFor = (items: readonly KnowledgeSearchResult[]) => {
      const returnedBundleIds = new Set(items.map((item) => item.bundleId));
      return Object.freeze(bundles.filter((bundle) => returnedBundleIds.has(bundle.id)).map((bundle) => Object.freeze({ bundleId: bundle.id, contentHash: tagged(bundle.contentHash) })));
    };
    const pageFor = (items: readonly KnowledgeSearchResult[]) => {
      const nextOffset = offset + items.length;
      return Object.freeze({
        query,
        total: results.length,
        items: Object.freeze(items),
        bundles: bundleViewFor(items),
        indexHash: tagged(index.indexHash),
        ...(nextOffset < results.length ? { nextCursor: encodeCursor({ v: 1, q: queryHash, i: index.indexHash, o: nextOffset }) } : {}),
      });
    };
    let page = pageFor(selected);
    while (selected.length > 1 && Buffer.byteLength(JSON.stringify(page), "utf8") > KNOWLEDGE_SEARCH_LIMITS.searchPageBytes) {
      selected = selected.slice(0, -1);
      page = pageFor(selected);
    }
    if (selected.length === 1 && Buffer.byteLength(JSON.stringify(page), "utf8") > KNOWLEDGE_SEARCH_LIMITS.searchPageBytes) {
      selected = [projectedSearchResult(results[offset], true)];
      page = pageFor(selected);
    }
    if (Buffer.byteLength(JSON.stringify(page), "utf8") > KNOWLEDGE_SEARCH_LIMITS.searchPageBytes) throw new Error("Knowledge search page cannot fit its bounded output contract");
    if (attemptId) this.recordSearch(nodeId, attemptId, page, indexInputBundles);
    return page;
  }

  read(nodeId: string, request: ReadRequest, attemptId?: string): KnowledgeReadPage {
    const attached = this.assertRead(nodeId);
    if (!request || !validKnowledgeBundleId(request.bundleId) || !validKnowledgeDocumentId(request.documentId)) throw new Error("Knowledge read identity is invalid");
    if (!attached.includes(request.bundleId)) throw new Error("Knowledge bundle is not attached to this node");
    const bundle = this.loadBundle(request.bundleId);
    const document = bundle.documents.find((entry) => entry.id === request.documentId);
    if (!document) throw new Error("Attached knowledge document is unavailable");
    const bundleCursorHash = sha256(request.bundleId);
    const bundleContentCursorHash = bundle.contentHash;
    const documentCursorHash = sha256(request.documentId);
    const cursor = decodeCursor(request.cursor);
    let offset = 0;
    if (cursor) {
      if (cursor.v !== 3 || cursor.b !== bundleCursorHash || cursor.bh !== bundleContentCursorHash || cursor.d !== documentCursorHash || cursor.h !== document.contentHash
        || !Number.isSafeInteger(cursor.o) || Number(cursor.o) < 0 || Number(cursor.o) > document.content.length) throw new Error("Knowledge read cursor is stale or invalid");
      offset = Number(cursor.o);
    }
    const candidate = utf8Prefix(document.content.slice(offset), KNOWLEDGE_SEARCH_LIMITS.readPageBytes);
    const pageFor = (content: string): KnowledgeReadPage => {
      const nextOffset = offset + content.length;
      return Object.freeze({
        bundleId: bundle.id,
        documentId: document.id,
        title: document.title,
        content,
        bundleContentHash: tagged(bundle.contentHash),
        contentHash: tagged(document.contentHash),
        returnedContentHash: tagged(sha256(content)),
        totalBytes: document.bytes,
        returnedBytes: Buffer.byteLength(content, "utf8"),
        ...(nextOffset < document.content.length ? { nextCursor: encodeCursor({ v: 3, b: bundleCursorHash, bh: bundleContentCursorHash, d: documentCursorHash, h: document.contentHash, o: nextOffset }) } : {}),
        readRef: knowledgeReadRef(bundle.id, document.id, document.contentHash),
      });
    };
    let page = pageFor(candidate);
    if (Buffer.byteLength(canonicalJson(page), "utf8") > KNOWLEDGE_SEARCH_LIMITS.readPageOutputBytes) {
      const boundaries = [0];
      let codeUnits = 0;
      for (const character of candidate) {
        codeUnits += character.length;
        boundaries.push(codeUnits);
      }
      let low = 1;
      let high = boundaries.length - 1;
      let accepted = 0;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const projected = pageFor(candidate.slice(0, boundaries[middle]));
        if (Buffer.byteLength(canonicalJson(projected), "utf8") <= KNOWLEDGE_SEARCH_LIMITS.readPageOutputBytes) {
          accepted = middle;
          low = middle + 1;
        } else high = middle - 1;
      }
      if (accepted === 0) throw new Error("Knowledge read page cannot make progress within its bounded output contract");
      page = pageFor(candidate.slice(0, boundaries[accepted]));
    }
    if (!page.content && offset < document.content.length) throw new Error("Knowledge read pagination could not make progress");
    if (Buffer.byteLength(canonicalJson(page), "utf8") > KNOWLEDGE_SEARCH_LIMITS.readPageOutputBytes) throw new Error("Knowledge read page cannot fit its bounded output contract");
    if (attemptId) this.recordRead(nodeId, attemptId, page);
    return page;
  }

  inspectReference(nodeId: string, bundleId: string, documentId: string, expectedHash?: string): Readonly<Record<string, JsonValue>> {
    const attached = this.assertRead(nodeId);
    if (!validKnowledgeBundleId(bundleId) || !validKnowledgeDocumentId(documentId) || !attached.includes(bundleId)) throw new Error("Knowledge reference is unauthorized");
    const bundle = this.loadBundle(bundleId);
    const document = bundle.documents.find((entry) => entry.id === documentId);
    if (!document || (expectedHash !== undefined && expectedHash !== document.contentHash && expectedHash !== tagged(document.contentHash))) throw new Error("Knowledge reference is unavailable or stale");
    return Object.freeze({
      bundleId,
      documentId,
      title: document.title,
      contentHash: tagged(document.contentHash),
      bundleContentHash: tagged(bundle.contentHash),
      readRef: knowledgeReadRef(bundleId, documentId, document.contentHash),
      trust: "untrusted-data",
    });
  }

  promptSummaries(nodeId: string): readonly DynamicPromptInput[] {
    if (!nodeHasKnowledgeRead(this.options.snapshot, nodeId) || attachedKnowledgeBundleIds(this.options.snapshot, nodeId).length === 0) return Object.freeze([]);
    const bundles = this.selectedBundles(nodeId).slice(0, KNOWLEDGE_SEARCH_LIMITS.promptBundles);
    return Object.freeze(bundles.map((bundle) => Object.freeze({
      source: "knowledge" as const,
      provenance: `${bundle.id}@${bundle.contentHash}`,
      ref: `knowledge:${bundle.id}`,
      content: {
        trust: "untrusted-data",
        bundleId: bundle.id,
        scope: bundle.ownerAgentId ? "agent-owned" : "shared-project",
        updatePolicy: bundle.updatePolicy,
        contentHash: tagged(bundle.contentHash),
        summary: utf8Prefix(bundle.summary, KNOWLEDGE_SEARCH_LIMITS.promptSummaryBytes),
        documents: bundle.documents.slice(0, KNOWLEDGE_SEARCH_LIMITS.promptDocumentsPerBundle).map((document) => ({
          id: document.id, title: document.title, ...(document.description ? { description: document.description } : {}), contentHash: tagged(document.contentHash), readRef: knowledgeReadRef(bundle.id, document.id, document.contentHash),
        })),
        truncated: bundle.documents.length > KNOWLEDGE_SEARCH_LIMITS.promptDocumentsPerBundle || Buffer.byteLength(bundle.summary, "utf8") > KNOWLEDGE_SEARCH_LIMITS.promptSummaryBytes,
      },
    })));
  }

  private append(nodeId: string, attemptId: string, payload: Record<string, JsonValue>): void {
    appendWorkflowEvent(this.options.projectRoot, createWorkflowEvent({
      projectId: this.options.projectId,
      sessionId: this.options.sessionId,
      runId: this.options.runId,
      type: "knowledge.transition",
      producer: "runtime",
      correlationId: attemptId,
      attemptId,
      timestamp: this.options.now?.(),
      payload: { formatVersion: 1, nodeId, attemptId, ...payload } as JsonValue,
    }));
  }

  private recordSearch(
    nodeId: string,
    attemptId: string,
    page: KnowledgeSearchPage,
    indexInputBundles: readonly Readonly<{ bundleId: string; contentHash: string }>[],
  ): void {
    this.append(nodeId, attemptId, {
      operation: "search",
      queryHash: tagged(sha256(page.query)),
      indexHash: page.indexHash,
      bundles: indexInputBundles.map((bundle) => ({ bundleId: bundle.bundleId, contentHash: bundle.contentHash })),
      total: page.total,
      results: page.items.map((item: KnowledgeSearchResult) => ({
        bundleId: item.bundleId, documentId: item.documentId, bundleContentHash: item.bundleContentHash, contentHash: item.contentHash, returnedContentHash: item.returnedContentHash, readRef: item.readRef,
      })),
      ...(page.nextCursor ? { nextCursorHash: tagged(sha256(page.nextCursor)) } : {}),
    });
  }

  private recordRead(nodeId: string, attemptId: string, page: KnowledgeReadPage): void {
    this.append(nodeId, attemptId, {
      operation: "read",
      bundleId: page.bundleId,
      documentId: page.documentId,
      bundleContentHash: page.bundleContentHash,
      contentHash: page.contentHash,
      returnedContentHash: page.returnedContentHash,
      returnedBytes: page.returnedBytes,
      readRef: page.readRef,
      ...(page.nextCursor ? { nextCursorHash: tagged(sha256(page.nextCursor)) } : {}),
    });
  }
}
