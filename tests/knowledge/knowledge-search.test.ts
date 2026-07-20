import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { ActivationSnapshotFileV1 } from "../../src/config/snapshot.ts";
import { canonicalJson } from "../../src/config/snapshot-canonical.ts";
import { readWorkflowJournal } from "../../src/workflows/journal.ts";
import { KnowledgeService, KNOWLEDGE_SEARCH_LIMITS } from "../../src/knowledge/search.ts";
import { attachedKnowledgeBundleIds, createKnowledgeReferenceAuthorizer } from "../../src/knowledge/attachments.ts";
import { buildKnowledgeLexicalIndex, KNOWLEDGE_INDEX_LIMITS, searchKnowledgeLexicalIndex } from "../../src/knowledge/index.ts";
import { KnowledgeProviderRegistry } from "../../src/knowledge/provider.ts";
import type { KnowledgeBundle, KnowledgeDocument } from "../../src/knowledge/types.ts";
import { DelegationRuntime } from "../../src/workflows/delegation.ts";
import { validateStructuredReference } from "../../src/workflows/references.ts";

function temp(): string { return mkdtempSync(join(tmpdir(), "pi-hive-knowledge-search-")); }
function write(path: string, value: string): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }
function concept(title: string, description: string, body: string, tags = ""): string {
  return `---\ntype: Reference\ntitle: ${title}\ndescription: ${description}\n${tags ? `tags: [${tags}]\n` : ""}---\n\n${body}\n`;
}

function snapshot(): ActivationSnapshotFileV1 {
  const caps = (knowledge: string[], read = true) => ({
    effective: { filesystem: [], shell: [], git: false, "external-network": false, "human-input": false, artifact: [], knowledge: read ? ["read"] : [] },
    provenance: {}, budgets: {}, attachments: { skills: [], knowledge }, directMemberIds: [],
  });
  return {
    snapshotHash: "a".repeat(64), createdAt: "2026-01-01T00:00:00.000Z", payload: {
      project: { projectId: "project-1", rootRef: "." },
      workflow: { id: "delivery", team: { rootId: "root", nodes: [
        { id: "root", agentId: "lead", memberIds: ["worker"], depth: 1, knowledge: { resolved: ["shared"] } },
        { id: "worker", agentId: "specialist", parentId: "root", memberIds: [], depth: 2, knowledge: { resolved: [] } },
        { id: "denied", agentId: "other", parentId: "root", memberIds: [], depth: 2, knowledge: { resolved: [] } },
      ] } },
      authority: { capabilityContractVersion: 1, nodes: [
        { nodeId: "root", capabilities: caps(["shared"]), tools: ["knowledge_read", "knowledge_search"] },
        { nodeId: "worker", capabilities: caps(["owned"]), tools: ["knowledge_read", "knowledge_search"] },
        { nodeId: "denied", capabilities: caps([], false), tools: [] },
      ] },
      agents: [{ id: "lead", prompt: "lead" }, { id: "specialist", prompt: "worker" }, { id: "other", prompt: "other" }], skills: [],
      knowledge: [
        { id: "owned", provider: "okf", path: ".pi/hive/knowledge/owned", owner: "specialist", updates: "automatic", metadataFingerprint: "1".repeat(64), attachedNodeIds: ["worker"] },
        { id: "shared", provider: "okf", path: ".pi/hive/knowledge/shared", updates: "reviewed", metadataFingerprint: "2".repeat(64), attachedNodeIds: ["root"] },
        { id: "secret", provider: "okf", path: ".pi/hive/knowledge/secret", updates: "reviewed", metadataFingerprint: "3".repeat(64), attachedNodeIds: [] },
      ], models: [], sources: [], versions: {} as never,
    },
  } as unknown as ActivationSnapshotFileV1;
}

function fixture() {
  const projectRoot = temp();
  write(join(projectRoot, ".pi/hive/knowledge/shared/zeta.md"), concept("Same", "same match", "alpha token"));
  write(join(projectRoot, ".pi/hive/knowledge/shared/alpha.md"), concept("Same", "same match", "alpha token"));
  write(join(projectRoot, ".pi/hive/knowledge/shared/api.md"), concept("Public API", "request routing", "The gateway routes public requests.", "gateway, api"));
  write(join(projectRoot, ".pi/hive/knowledge/owned/tactics.md"), concept("Specialist tactics", "private specialist memory", "repeatable diagnosis"));
  write(join(projectRoot, ".pi/hive/knowledge/secret/passwords.md"), concept("Passwords", "must not leak", "TOP-SECRET-CONTENT"));
  return { projectRoot, snapshot: snapshot() };
}

function snapshotWithBundles(bundleIds: readonly string[]): ActivationSnapshotFileV1 {
  const value = structuredClone(snapshot()) as any;
  const rootNode = value.payload.workflow.team.nodes.find((entry: any) => entry.id === "root");
  rootNode.memberIds = [];
  rootNode.knowledge.resolved = [...bundleIds];
  value.payload.workflow.team.nodes = [rootNode];
  const rootAuthority = value.payload.authority.nodes.find((entry: any) => entry.nodeId === "root");
  rootAuthority.capabilities.attachments.knowledge = [...bundleIds];
  value.payload.authority.nodes = [rootAuthority];
  value.payload.knowledge = bundleIds.map((id) => ({
    id, provider: "okf", path: `.pi/hive/knowledge/${id}`, updates: "reviewed",
    metadataFingerprint: createHash("sha256").update(`metadata:${id}`).digest("hex"), attachedNodeIds: ["root"],
  }));
  return value as ActivationSnapshotFileV1;
}

function bundle(id: string, totalBytes: number, documents: readonly KnowledgeDocument[] = []): KnowledgeBundle {
  return Object.freeze({
    id, providerId: "okf", updatePolicy: "reviewed", canonicalRoot: ".", documents: Object.freeze([...documents]), summary: `Summary for ${id}`,
    contentHash: createHash("sha256").update(`bundle:${id}`).digest("hex"), totalBytes, diagnostics: Object.freeze([]),
  });
}

function syntheticService(
  bundleIds: readonly string[],
  loader: (id: string, reserveContentBytes: ((bytes: number) => void) | undefined) => KnowledgeBundle,
  projectRoot = temp(),
): KnowledgeService {
  const providers = new KnowledgeProviderRegistry();
  providers.register({
    id: "okf", version: "test-v1",
    load(request) {
      const loaded = loader(request.declaration.id, request.reserveContentBytes);
      return Object.freeze({ ok: true, bundle: loaded, diagnostics: Object.freeze([]) });
    },
  });
  return new KnowledgeService({ projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: snapshotWithBundles(bundleIds), providers });
}

test("attachments come only from frozen authority even when persisted owner metadata is tampered", () => {
  const f = fixture();
  assert.deepEqual(attachedKnowledgeBundleIds(f.snapshot, "root"), ["shared"]);
  assert.deepEqual(attachedKnowledgeBundleIds(f.snapshot, "worker"), ["owned"]);
  assert.deepEqual(attachedKnowledgeBundleIds(f.snapshot, "denied"), []);
  const tampered = structuredClone(f.snapshot) as any;
  tampered.payload.knowledge.find((entry: any) => entry.id === "secret").owner = "lead";
  tampered.payload.knowledge.find((entry: any) => entry.id === "secret").attachedNodeIds = ["root"];
  assert.deepEqual(attachedKnowledgeBundleIds(tampered, "root"), ["shared"], "owner and informational reverse indexes cannot grant runtime attachment authority");
  const service = new KnowledgeService({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: f.snapshot });
  assert.throws(() => service.read("root", { bundleId: "secret", documentId: "passwords" }), (error: Error) => {
    assert.match(error.message, /not attached|denied/i);
    assert.equal(error.message.includes("TOP-SECRET"), false);
    return true;
  });
  assert.throws(() => service.search("denied", { query: "secret" }), /knowledge\.read|denied/i);
});

test("lexical search ranking, ties, pagination, bounds, and invalidation are deterministic and local", () => {
  const f = fixture();
  const service = new KnowledgeService({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: f.snapshot });
  const api = service.search("root", { query: "gateway", limit: 10 });
  assert.equal(api.items[0].documentId, "api", "title/tag/description weighting should rank the API document");
  const ties = service.search("root", { query: "same", limit: 1 });
  assert.equal(ties.items[0].documentId, "alpha");
  assert.ok(ties.nextCursor);
  const ties2 = service.search("root", { query: "same", limit: 1, cursor: ties.nextCursor });
  assert.equal(ties2.items[0].documentId, "zeta");
  assert.throws(() => service.search("root", { query: "x".repeat(KNOWLEDGE_SEARCH_LIMITS.queryBytes + 1) }), /query.*limit/i);
  assert.throws(() => service.search("root", { query: "alpha", cursor: "copied-from-another-query" }), /cursor/i);

  const before = service.search("root", { query: "newterm" });
  assert.equal(before.items.length, 0);
  write(join(f.projectRoot, ".pi/hive/knowledge/shared/api.md"), concept("Public API", "request routing", "newterm now exists"));
  const after = service.search("root", { query: "newterm" });
  assert.equal(after.items[0].documentId, "api", "content changes must invalidate the lexical index before serving");
});

test("one tokensPerDocument budget is shared across all indexed fields at N and N+1", () => {
  const document = (titleTokens: number, body: string): KnowledgeBundle => ({
    id: "shared", providerId: "test", updatePolicy: "reviewed", canonicalRoot: ".", summary: "", contentHash: "a".repeat(64), totalBytes: 1, diagnostics: [],
    documents: [{
      id: "doc", type: "Reference", title: "filler ".repeat(titleTokens), tags: [], body, content: body,
      contentHash: "b".repeat(64), bytes: Buffer.byteLength(body), links: [],
    }],
  });
  // id and type consume two tokens before the body, so this places `included` at exact token N.
  const exact = buildKnowledgeLexicalIndex([document(KNOWLEDGE_INDEX_LIMITS.tokensPerDocument - 3, "included overflow")]);
  assert.equal(searchKnowledgeLexicalIndex(exact, "included").length, 1, "the Nth token is indexed");
  assert.equal(searchKnowledgeLexicalIndex(exact, "overflow").length, 0, "the N+1 token is excluded");

  const exhaustedByTitle = buildKnowledgeLexicalIndex([document(KNOWLEDGE_INDEX_LIMITS.tokensPerDocument, "bodyonly")]);
  assert.equal(searchKnowledgeLexicalIndex(exhaustedByTitle, "bodyonly").length, 0, "a later field cannot receive a fresh per-document budget");
});

test("search shares one operation-local aggregate reservation and rejects N+1 before the next provider content read", () => {
  const ids = ["bundle-a", "bundle-b", "bundle-c"] as const;
  const half = KNOWLEDGE_INDEX_LIMITS.aggregateBytes / 2;
  const sizes = new Map<string, number>([[ids[0], half], [ids[1], half], [ids[2], 1]]);
  const exactReads: string[] = [];
  const exact = syntheticService(ids.slice(0, 2), (id, reserve) => {
    reserve?.(sizes.get(id)!);
    exactReads.push(id);
    return bundle(id, sizes.get(id)!);
  });
  assert.equal(exact.search("root", { query: "anything" }).items.length, 0);
  assert.deepEqual(exactReads, ids.slice(0, 2), "the exact aggregate N-byte operation remains accepted");

  const overflowReads: string[] = [];
  const overflow = syntheticService(ids, (id, reserve) => {
    reserve?.(sizes.get(id)!);
    overflowReads.push(id);
    return bundle(id, sizes.get(id)!);
  });
  assert.throws(() => overflow.search("root", { query: "anything" }), /aggregate|byte limit|budget/i);
  assert.deepEqual(overflowReads, ids.slice(0, 2), "N+1 must fail in reservation before the next provider content read");
});

test("prompt summaries share one operation-local aggregate reservation and reject N+1 before the next provider content read", () => {
  const ids = ["bundle-a", "bundle-b", "bundle-c"] as const;
  const half = KNOWLEDGE_INDEX_LIMITS.aggregateBytes / 2;
  const sizes = new Map<string, number>([[ids[0], half], [ids[1], half], [ids[2], 1]]);
  const exactReads: string[] = [];
  const exact = syntheticService(ids.slice(0, 2), (id, reserve) => {
    reserve?.(sizes.get(id)!);
    exactReads.push(id);
    return bundle(id, sizes.get(id)!);
  });
  assert.equal(exact.promptSummaries("root").length, 2);
  assert.deepEqual(exactReads, ids.slice(0, 2), "the exact aggregate N-byte operation remains accepted");

  const overflowReads: string[] = [];
  const overflow = syntheticService(ids, (id, reserve) => {
    reserve?.(sizes.get(id)!);
    overflowReads.push(id);
    return bundle(id, sizes.get(id)!);
  });
  assert.throws(() => overflow.promptSummaries("root"), /aggregate|byte limit|budget/i);
  assert.deepEqual(overflowReads, ids.slice(0, 2), "N+1 must fail in reservation before the next provider content read");
});

test("even one adversarial search result stays under service/tool bounds while journaling every selected bundle version", () => {
  const bundleIds = Array.from({ length: 128 }, (_, index) => (`b${String(index).padStart(3, "0")}-${"x".repeat(250)}`).slice(0, 255));
  const documentId = Array.from({ length: 8 }, () => "\"".repeat(190)).join("/");
  const source = "exact source bytes";
  const body = `match ${"\\".repeat(1_010)}`;
  const documentHash = createHash("sha256").update(source).digest("hex");
  const document: KnowledgeDocument = Object.freeze({
    id: documentId,
    type: "Reference",
    title: "\\".repeat(1_020),
    description: "\\".repeat(4_090),
    tags: Object.freeze([]),
    body,
    content: source,
    contentHash: documentHash,
    bytes: Buffer.byteLength(source, "utf8"),
    links: Object.freeze([]),
  });
  const projectRoot = temp();
  const service = syntheticService(bundleIds, (id, reserve) => {
    reserve?.(1);
    return bundle(id, 1, id === bundleIds[0] ? [document] : []);
  }, projectRoot);
  const query = ["match", ...Array.from({ length: 63 }, (_, index) => `q${index}${"x".repeat(57)}`)].join(" ");
  const page = service.search("root", { query, limit: 1 }, "attempt-bounded-search");
  const serializedBytes = Buffer.byteLength(JSON.stringify(page), "utf8");
  assert.equal(page.items.length, 1);
  assert.ok(serializedBytes <= 60_000, `service page was ${serializedBytes} bytes`);
  assert.ok(serializedBytes <= 65_536, `generic tool page was ${serializedBytes} bytes`);
  assert.deepEqual(page.bundles.map((entry) => entry.bundleId), [page.items[0].bundleId], "bounded agent page provenance includes only bundles represented in returned items");
  assert.equal(page.items[0].bundleContentHash, page.bundles[0].contentHash);
  assert.equal(page.items[0].contentHash, `sha256:${documentHash}`);
  assert.equal(page.items[0].returnedContentHash, `sha256:${createHash("sha256").update(page.items[0].snippet).digest("hex")}`);
  assert.equal(page.items[0].readRef, `knowledge:${bundleIds[0]}/${documentId}@${documentHash}`);
  assert.match(page.indexHash, /^sha256:[0-9a-f]{64}$/u);

  const event = readWorkflowJournal(projectRoot, "session-1").find((entry) => entry.type === "knowledge.transition");
  assert.ok(event);
  const payload = event.payload as any;
  assert.equal(payload.bundles.length, bundleIds.length);
  assert.deepEqual(payload.bundles.map((entry: any) => entry.bundleId), [...bundleIds].sort());
  assert.equal(payload.bundles.find((entry: any) => entry.bundleId === page.items[0].bundleId)?.contentHash, page.items[0].bundleContentHash);
  assert.deepEqual(payload.results.map((item: any) => item.documentId), page.items.map((item) => item.documentId));
  assert.deepEqual(payload.results.map((item: any) => item.returnedContentHash), page.items.map((item) => item.returnedContentHash));
});

test("zero-result and later-page search journals retain the complete selected index input bundle set", () => {
  const projectRoot = temp();
  const ids = ["bundle-a", "bundle-b"] as const;
  const document = (id: string): KnowledgeDocument => {
    const content = `${id} shared-term`;
    return Object.freeze({
      id: `doc-${id}`, type: "Reference", title: id, tags: Object.freeze([]), body: content, content,
      contentHash: createHash("sha256").update(content).digest("hex"), bytes: Buffer.byteLength(content), links: Object.freeze([]),
    });
  };
  const service = syntheticService(ids, (id, reserve) => {
    const value = document(id);
    reserve?.(value.bytes);
    return bundle(id, value.bytes, [value]);
  }, projectRoot);

  service.search("root", { query: "unfindable" }, "attempt-zero");
  const first = service.search("root", { query: "shared-term", limit: 1 }, "attempt-first");
  assert.ok(first.nextCursor);
  service.search("root", { query: "shared-term", limit: 1, cursor: first.nextCursor }, "attempt-later");

  const events = readWorkflowJournal(projectRoot, "session-1").filter((entry) => entry.type === "knowledge.transition");
  assert.equal(events.length, 3);
  for (const event of events) {
    const payload = event.payload as any;
    assert.deepEqual(payload.bundles.map((entry: any) => entry.bundleId), ids);
    assert.equal(payload.bundles.every((entry: any) => /^sha256:[0-9a-f]{64}$/u.test(entry.contentHash)), true);
    assert.match(payload.indexHash, /^sha256:[0-9a-f]{64}$/u);
  }
  assert.equal((events[0].payload as any).results.length, 0);
  assert.equal((events[2].payload as any).results.length, 1);
});

test("search omits an absent optional description so generic tool canonical serialization remains valid", () => {
  const source = "exact source";
  const document: KnowledgeDocument = Object.freeze({
    id: "doc", type: "Reference", title: "Document", tags: Object.freeze([]), body: "matching body", content: source,
    contentHash: createHash("sha256").update(source).digest("hex"), bytes: Buffer.byteLength(source), links: Object.freeze([]),
  });
  const service = syntheticService(["shared"], (id, reserve) => {
    reserve?.(document.bytes);
    return bundle(id, document.bytes, [document]);
  });
  const page = service.search("root", { query: "matching", limit: 1 });
  assert.equal(Object.hasOwn(page.items[0], "description"), false);
  assert.doesNotThrow(() => canonicalJson(page));
});

test("search and read cursors fail stale when document or exact bundle content changes between pages", () => {
  const f = fixture();
  const service = new KnowledgeService({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: f.snapshot });
  const firstSearch = service.search("root", { query: "same", limit: 1 });
  assert.ok(firstSearch.nextCursor);
  write(join(f.projectRoot, ".pi/hive/knowledge/shared/zeta.md"), concept("Same", "same match", "alpha token changed"));
  assert.throws(() => service.search("root", { query: "same", limit: 1, cursor: firstSearch.nextCursor }), /stale/i);

  const original = concept("Large", "large document", "😀".repeat(12_000));
  const largePath = join(f.projectRoot, ".pi/hive/knowledge/shared/large.md");
  write(largePath, original);
  const cursorBefore = (mutation: () => void): string => {
    const page = service.read("root", { bundleId: "shared", documentId: "large" });
    assert.ok(page.nextCursor);
    mutation();
    return page.nextCursor;
  };

  const documentCursor = cursorBefore(() => write(largePath, `${original}\nchanged between pages\n`));
  assert.throws(() => service.read("root", { bundleId: "shared", documentId: "large", cursor: documentCursor }), /stale/i);
  write(largePath, original);

  const siblingCursor = cursorBefore(() => write(join(f.projectRoot, ".pi/hive/knowledge/shared/api.md"), concept("Public API", "request routing", "Sibling changed.")));
  assert.throws(() => service.read("root", { bundleId: "shared", documentId: "large", cursor: siblingCursor }), /stale/i);

  const indexPath = join(f.projectRoot, ".pi/hive/knowledge/shared/index.md");
  write(indexPath, "---\nokf_version: \"0.1\"\n---\n# Concepts\n\n* [Large](large.md) - large document\n");
  const indexCursor = cursorBefore(() => write(indexPath, "---\nokf_version: \"0.1\"\n---\n# Concepts\n\n* [Large](large.md) - changed index description\n"));
  assert.throws(() => service.read("root", { bundleId: "shared", documentId: "large", cursor: indexCursor }), /stale/i);

  const logPath = join(f.projectRoot, ".pi/hive/knowledge/shared/log.md");
  write(logPath, "# Directory Update Log\n\n## 2026-01-01\n* Added large document.\n");
  const logCursor = cursorBefore(() => write(logPath, "# Directory Update Log\n\n## 2026-01-02\n* Updated large document metadata.\n"));
  assert.throws(() => service.read("root", { bundleId: "shared", documentId: "large", cursor: logCursor }), /stale/i);
});

test("prompt knowledge summaries are bounded, progressive, and explicitly untrusted", () => {
  const f = fixture();
  const service = new KnowledgeService({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: f.snapshot });
  const summaries = service.promptSummaries("root");
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].source, "knowledge");
  assert.equal((summaries[0].content as any).trust, "untrusted-data");
  assert.ok(Buffer.byteLength((summaries[0].content as any).summary, "utf8") <= 16_384);
  assert.equal(JSON.stringify(summaries).includes("TOP-SECRET-CONTENT"), false);
  assert.match(JSON.stringify(summaries), /knowledge:shared\/api@[0-9a-f]{64}/);
});

test("knowledge reads paginate on UTF-8 boundaries without changing exact content hashes", () => {
  const f = fixture();
  const exact = concept("Large", "large document", "😀".repeat(12_000));
  write(join(f.projectRoot, ".pi/hive/knowledge/shared/large.md"), exact);
  const service = new KnowledgeService({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: f.snapshot });
  let cursor: string | undefined;
  let reconstructed = "";
  let contentHash = "";
  do {
    const page = service.read("root", { bundleId: "shared", documentId: "large", ...(cursor ? { cursor } : {}) });
    reconstructed += page.content;
    contentHash ||= page.contentHash;
    assert.equal(page.returnedContentHash, `sha256:${createHash("sha256").update(page.content, "utf8").digest("hex")}`);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(reconstructed, exact);
  assert.equal(contentHash, `sha256:${createHash("sha256").update(exact, "utf8").digest("hex")}`);
});

test("read pages bound the complete canonical envelope under quote, backslash, control, and newline expansion", () => {
  const source = `---\ntype: Reference\ntitle: Escaped page\n---\n\n${"\\\"\u0000\u0001\n".repeat(12_000)}`;
  const document: KnowledgeDocument = Object.freeze({
    id: "escaped", type: "Reference", title: "Escaped page", tags: Object.freeze([]), body: source, content: source,
    contentHash: createHash("sha256").update(source).digest("hex"), bytes: Buffer.byteLength(source), links: Object.freeze([]),
  });
  const service = syntheticService(["shared"], (id, reserve) => {
    reserve?.(document.bytes);
    return bundle(id, document.bytes, [document]);
  });
  let cursor: string | undefined;
  let reconstructed = "";
  let pages = 0;
  do {
    const page = service.read("root", { bundleId: "shared", documentId: "escaped", ...(cursor ? { cursor } : {}) });
    const envelopeBytes = Buffer.byteLength(canonicalJson(page), "utf8");
    assert.ok(envelopeBytes <= 65_536, `canonical read envelope was ${envelopeBytes} bytes`);
    assert.ok(page.content.length > 0, "every non-terminal page must make forward progress");
    reconstructed += page.content;
    cursor = page.nextCursor;
    pages++;
  } while (cursor);
  assert.ok(pages > 1);
  assert.equal(reconstructed, source);
});

test("read cursors stay fixed-size at the transport-safe document ID boundary and reject N+1", () => {
  const documentIdWithBytes = (bytes: number): string => {
    const parts: string[] = [];
    while (Buffer.byteLength([...parts, "x".repeat(200)].join("/"), "utf8") <= bytes) parts.push("x".repeat(200));
    const remaining = bytes - Buffer.byteLength(parts.join("/"), "utf8") - (parts.length ? 1 : 0);
    if (remaining > 0) parts.push("x".repeat(remaining));
    return parts.join("/");
  };
  const documentId = documentIdWithBytes(1_716);
  const oversizedDocumentId = documentIdWithBytes(1_717);
  assert.equal(Buffer.byteLength(documentId), 1_716);
  assert.equal(Buffer.byteLength(oversizedDocumentId), 1_717);
  let source = "a".repeat(80_000);
  const service = syntheticService(["shared"], (id, reserve) => {
    const document = (documentIdentity: string): KnowledgeDocument => Object.freeze({
      id: documentIdentity, type: "Reference", title: "Maximum ID", tags: Object.freeze([]), body: source, content: source,
      contentHash: createHash("sha256").update(source).digest("hex"), bytes: Buffer.byteLength(source), links: Object.freeze([]),
    });
    reserve?.(Buffer.byteLength(source));
    return bundle(id, Buffer.byteLength(source), [document(documentId), document(oversizedDocumentId)]);
  });
  const first = service.read("root", { bundleId: "shared", documentId });
  assert.ok(first.nextCursor);
  assert.ok(Buffer.byteLength(first.nextCursor, "utf8") <= 512, `read cursor was ${Buffer.byteLength(first.nextCursor, "utf8")} bytes`);
  const second = service.read("root", { bundleId: "shared", documentId, cursor: first.nextCursor });
  assert.ok(second.returnedBytes > 0);
  assert.throws(() => service.read("root", { bundleId: "shared", documentId: oversizedDocumentId }), /identity/i);
  source = `${source.slice(0, -1)}b`;
  assert.throws(() => service.read("root", { bundleId: "shared", documentId, cursor: first.nextCursor }), /stale/i);
});

test("search/read provenance journals exact document and returned-byte hashes", () => {
  const f = fixture();
  const service = new KnowledgeService({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: f.snapshot });
  const search = service.search("root", { query: "gateway", limit: 2 }, "attempt-search");
  const read = service.read("root", { bundleId: "shared", documentId: "api" }, "attempt-read");
  assert.equal(read.returnedContentHash, `sha256:${createHash("sha256").update(read.content, "utf8").digest("hex")}`);
  assert.match(read.contentHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(read.returnedContentHash, /^sha256:[0-9a-f]{64}$/);
  const events = readWorkflowJournal(f.projectRoot, "session-1").filter((event) => event.type === "knowledge.transition");
  assert.equal(events.length, 2);
  const searchPayload = events[0].payload as any;
  const readPayload = events[1].payload as any;
  assert.equal(searchPayload.operation, "search");
  assert.equal(searchPayload.bundles[0].contentHash, search.bundles[0].contentHash);
  assert.equal(searchPayload.results[0].bundleContentHash, search.items[0].bundleContentHash);
  assert.equal(searchPayload.results[0].contentHash, search.items[0].contentHash);
  assert.equal(searchPayload.results[0].returnedContentHash, search.items[0].returnedContentHash);
  assert.equal(readPayload.operation, "read");
  assert.equal(readPayload.bundleContentHash, read.bundleContentHash);
  assert.equal(readPayload.contentHash, read.contentHash);
  assert.equal(readPayload.returnedContentHash, read.returnedContentHash);
});

test("maximum public knowledge read refs fit structured-reference transport and recipient delegation", () => {
  const bundleId = `b${"x".repeat(255)}`;
  const parts: string[] = [];
  while (Buffer.byteLength([...parts, "x".repeat(200)].join("/"), "utf8") <= 1_716) parts.push("x".repeat(200));
  const remaining = 1_716 - Buffer.byteLength(parts.join("/"), "utf8") - (parts.length ? 1 : 0);
  if (remaining > 0) parts.push("x".repeat(remaining));
  const documentId = parts.join("/");
  const content = "boundary recipient delegation";
  const document: KnowledgeDocument = Object.freeze({
    id: documentId, type: "Reference", title: "Boundary", tags: Object.freeze([]), body: content, content,
    contentHash: createHash("sha256").update(content).digest("hex"), bytes: Buffer.byteLength(content), links: Object.freeze([]),
  });
  const active = structuredClone(snapshotWithBundles([bundleId])) as any;
  active.payload.workflow.team.nodes[0].memberIds = ["worker"];
  active.payload.workflow.team.nodes.push({ id: "worker", agentId: "specialist", parentId: "root", memberIds: [], depth: 2, knowledge: { resolved: [bundleId] } });
  active.payload.authority.nodes[0].capabilities.directMemberIds = ["worker"];
  active.payload.authority.nodes.push({
    nodeId: "worker",
    capabilities: structuredClone(active.payload.authority.nodes[0].capabilities),
    tools: ["knowledge_read", "knowledge_search"],
  });
  active.payload.knowledge[0].attachedNodeIds = ["root", "worker"];
  const providers = new KnowledgeProviderRegistry();
  providers.register({
    id: "okf", version: "boundary-v1",
    load: (request) => ({ ok: true, bundle: bundle(request.declaration.id, document.bytes, [document]), diagnostics: [] }),
  });
  const projectRoot = temp();
  const service = new KnowledgeService({ projectRoot, projectId: "project-1", sessionId: "session-boundary", runId: "run-boundary", snapshot: active, providers });
  const page = service.search("root", { query: "boundary", limit: 1 });
  assert.equal(Buffer.byteLength(page.items[0].readRef, "utf8"), 2_048);
  const transported = validateStructuredReference({ kind: "knowledge", id: page.items[0].readRef.slice("knowledge:".length) });
  assert.ok(Buffer.byteLength(transported.id, "utf8") <= 2_048);

  const runtime = new DelegationRuntime({
    projectRoot, projectId: "project-1", sessionId: "session-boundary", runId: "run-boundary", snapshot: active,
    createTaskId: () => "task-boundary", referenceAuthorizer: createKnowledgeReferenceAuthorizer(active, service),
  });
  const accepted = runtime.accept(runtime.rootExecutionContext(), {
    targetNodeId: "worker", objective: "Use the transport-boundary knowledge ref", deliverables: ["result"], contextRefs: [transported],
  });
  assert.equal(runtime.restore().tasks[accepted.taskId].contextRefs[0].authorization, "authorized");
});

test("knowledge references are re-authorized for their recipient and expose only provenance", () => {
  const f = fixture();
  const service = new KnowledgeService({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-1", snapshot: f.snapshot });
  const authorizer = createKnowledgeReferenceAuthorizer(f.snapshot, service);
  const allowed = authorizer.authorize({ kind: "knowledge", id: "owned/tactics" }, "worker");
  assert.equal(allowed.authorized, true);
  assert.equal(JSON.stringify(allowed).includes("repeatable diagnosis"), false);
  const denied = authorizer.authorize({ kind: "knowledge", id: "secret/passwords" }, "worker");
  assert.equal(denied.authorized, false);
  assert.equal(JSON.stringify(denied).includes("TOP-SECRET"), false);
});

test("delegation context and worker-result knowledge refs reauthorize for each recipient", () => {
  const f = fixture();
  const rootAuthority = f.snapshot.payload.authority.nodes.find((entry) => entry.nodeId === "root") as any;
  rootAuthority.capabilities.directMemberIds = ["worker"];
  const service = new KnowledgeService({ projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-1", runId: "run-refs", snapshot: f.snapshot });
  const runtime = new DelegationRuntime({
    projectRoot: f.projectRoot, projectId: "project-1", sessionId: "session-refs", runId: "run-refs", snapshot: f.snapshot,
    createTaskId: () => "task-refs", now: () => "2026-01-01T00:00:00.000Z",
    referenceAuthorizer: createKnowledgeReferenceAuthorizer(f.snapshot, service),
  });
  const accepted = runtime.accept(runtime.rootExecutionContext(), {
    targetNodeId: "worker", objective: "Inspect recipient-authorized knowledge", deliverables: ["refs"],
    contextRefs: [
      { kind: "knowledge", id: "owned/tactics" },
      { kind: "knowledge", id: "shared/api" },
    ],
  });
  const task = runtime.restore().tasks[accepted.taskId];
  assert.deepEqual(task.contextRefs.map((entry) => entry.authorization), ["authorized", "denied"]);
  runtime.start(accepted.taskId, "attempt-refs");
  runtime.recordResult(accepted.taskId, {
    status: "completed", summary: "done",
    outputRefs: [
      { kind: "knowledge", id: "shared/api" },
      { kind: "knowledge", id: "owned/tactics" },
    ],
  });
  const terminal = runtime.restore().tasks[accepted.taskId];
  assert.deepEqual(terminal.result?.outputRefs.map((entry) => entry.authorization), ["authorized", "denied"]);
  const contextDenied = task.contextRefs[1];
  const outputDenied = terminal.result?.outputRefs[1];
  assert.equal(contextDenied.authorization, "denied");
  assert.equal(outputDenied?.authorization, "denied");
  if (contextDenied.authorization === "denied" && outputDenied?.authorization === "denied") assert.equal(contextDenied.diagnostic, outputDenied.diagnostic);
  assert.equal(JSON.stringify({ contextDenied, outputDenied }).includes("gateway routes"), false);
  assert.equal(JSON.stringify({ contextDenied, outputDenied }).includes("repeatable diagnosis"), false);
});
