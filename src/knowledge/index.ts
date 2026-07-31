import { createHash } from "node:crypto";
import { knowledgeReadRef, type KnowledgeBundle, type KnowledgeDocument, type KnowledgeSearchResult } from "./types";

export const KNOWLEDGE_INDEX_LIMITS = Object.freeze({
  bundles: 128,
  documents: 4_096,
  aggregateBytes: 16_777_216,
  tokens: 1_000_000,
  tokensPerDocument: 32_768,
  tokenBytes: 128,
  snippetBytes: 1_024,
});

interface IndexedDocument {
  readonly bundleId: string;
  readonly bundleContentHash: string;
  readonly document: KnowledgeDocument;
  readonly fields: Readonly<Record<"id" | "title" | "description" | "tags" | "type" | "body", ReadonlyMap<string, number>>>;
}
export interface KnowledgeLexicalIndex {
  readonly indexHash: string;
  readonly documents: readonly IndexedDocument[];
}

function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
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

export function tokenizeKnowledgeText(value: string, maximum: number = KNOWLEDGE_INDEX_LIMITS.tokensPerDocument): readonly string[] {
  if (maximum <= 0) return Object.freeze([]);
  const normalized = value.normalize("NFKC").toLocaleLowerCase("en-US");
  const matches = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const output: string[] = [];
  for (const token of matches) {
    if (Buffer.byteLength(token, "utf8") <= KNOWLEDGE_INDEX_LIMITS.tokenBytes) output.push(token);
    if (output.length >= maximum) break;
  }
  return Object.freeze(output);
}
function frequencies(value: string, documentBudget: { remaining: number }): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  const tokens = tokenizeKnowledgeText(value, documentBudget.remaining);
  documentBudget.remaining -= tokens.length;
  for (const token of tokens) result.set(token, Math.min(255, (result.get(token) ?? 0) + 1));
  return result;
}

export function buildKnowledgeLexicalIndex(bundles: readonly KnowledgeBundle[]): KnowledgeLexicalIndex {
  if (bundles.length > KNOWLEDGE_INDEX_LIMITS.bundles) throw new Error("Knowledge index bundle limit exceeded");
  const sortedBundles = [...bundles].sort((left, right) => compare(left.id, right.id));
  const documentCount = sortedBundles.reduce((total, bundle) => total + bundle.documents.length, 0);
  const bytes = sortedBundles.reduce((total, bundle) => total + bundle.totalBytes, 0);
  if (documentCount > KNOWLEDGE_INDEX_LIMITS.documents || bytes > KNOWLEDGE_INDEX_LIMITS.aggregateBytes) throw new Error("Knowledge index document or byte limit exceeded");
  const budget = { remaining: KNOWLEDGE_INDEX_LIMITS.tokens };
  const documents: IndexedDocument[] = [];
  const hash = createHash("sha256").update("pi-hive-knowledge-index-v1\0");
  for (const bundle of sortedBundles) {
    hash.update(bundle.id).update("\0").update(bundle.contentHash).update("\0");
    for (const document of bundle.documents) {
      if (budget.remaining <= 0) throw new Error("Knowledge index token limit exceeded");
      const documentBudget = { remaining: Math.min(KNOWLEDGE_INDEX_LIMITS.tokensPerDocument, budget.remaining) };
      const initialDocumentBudget = documentBudget.remaining;
      const fields = Object.freeze({
        id: frequencies(document.id.replaceAll("/", " "), documentBudget),
        title: frequencies(document.title, documentBudget),
        description: frequencies(document.description ?? "", documentBudget),
        tags: frequencies(document.tags.join(" "), documentBudget),
        type: frequencies(document.type, documentBudget),
        body: frequencies(document.body, documentBudget),
      });
      budget.remaining -= initialDocumentBudget - documentBudget.remaining;
      documents.push(Object.freeze({ bundleId: bundle.id, bundleContentHash: bundle.contentHash, document, fields }));
    }
  }
  return Object.freeze({ indexHash: hash.digest("hex"), documents: Object.freeze(documents) });
}

const WEIGHTS = Object.freeze({ id: 3, title: 12, description: 6, tags: 8, type: 2, body: 1 });
function scoreDocument(indexed: IndexedDocument, terms: readonly string[]): number {
  let score = 0;
  for (const term of terms) for (const [field, frequency] of Object.entries(indexed.fields) as Array<[keyof typeof WEIGHTS, ReadonlyMap<string, number>]>) {
    score += Math.min(16, frequency.get(term) ?? 0) * WEIGHTS[field];
  }
  return score;
}
function snippet(document: KnowledgeDocument, terms: readonly string[]): string {
  const lines = document.body.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const selected = lines.find((line) => {
    const tokens = new Set(tokenizeKnowledgeText(line));
    return terms.some((term) => tokens.has(term));
  }) ?? document.description ?? lines[0] ?? document.title;
  return utf8Prefix(selected, KNOWLEDGE_INDEX_LIMITS.snippetBytes);
}
function tagged(hash: string): string { return `sha256:${hash}`; }

export function searchKnowledgeLexicalIndex(index: KnowledgeLexicalIndex, query: string): readonly KnowledgeSearchResult[] {
  const terms = [...new Set(tokenizeKnowledgeText(query, 64))];
  if (!terms.length) return Object.freeze([]);
  const results = index.documents.flatMap((indexed) => {
    const score = scoreDocument(indexed, terms);
    if (score <= 0) return [];
    const preview = snippet(indexed.document, terms);
    return [Object.freeze({
      bundleId: indexed.bundleId,
      documentId: indexed.document.id,
      title: indexed.document.title,
      ...(indexed.document.description ? { description: indexed.document.description } : {}),
      score,
      snippet: preview,
      bundleContentHash: tagged(indexed.bundleContentHash),
      contentHash: tagged(indexed.document.contentHash),
      returnedContentHash: tagged(createHash("sha256").update(preview, "utf8").digest("hex")),
      readRef: knowledgeReadRef(indexed.bundleId, indexed.document.id, indexed.document.contentHash),
    })];
  });
  return Object.freeze(results.sort((left, right) => right.score - left.score || compare(left.bundleId, right.bundleId) || compare(left.documentId, right.documentId)));
}
