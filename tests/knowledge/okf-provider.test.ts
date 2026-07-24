import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadOkfBundle, OKF_PROVIDER_LIMITS, type OkfProviderLimits } from "../../src/knowledge/okf.ts";
import { validKnowledgeDocumentId } from "../../src/knowledge/types.ts";

function temp(): string { return mkdtempSync(join(tmpdir(), "pi-hive-okf-")); }
function write(path: string, value: string | Uint8Array): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }
function concept(type: string, title: string, body: string, extra = ""): string {
  return `---\ntype: ${type}\ntitle: ${title}\ndescription: ${title} description\n${extra}---\n\n${body}\n`;
}

function load(projectRoot: string, relative = ".pi/hive/knowledge/shared", limits?: Partial<OkfProviderLimits>) {
  return loadOkfBundle({
    projectRoot,
    declaration: { id: "shared", providerId: "okf", path: relative, updatePolicy: "reviewed" },
    ...(limits ? { limits } : {}),
  });
}

test("minimal OKF bundle preserves provider-neutral documents, links, and bounded progressive summary", () => {
  const root = temp();
  write(join(root, ".pi/hive/knowledge/shared/index.md"), "# Architecture\n\n* [API](api.md) - public API\n");
  write(join(root, ".pi/hive/knowledge/shared/api.md"), concept("Reference", "API", "See [database](./db.md), [future](/future.md), and [source](https://example.test).", "producer_extension: kept\n"));
  write(join(root, ".pi/hive/knowledge/shared/db.md"), concept("Reference", "Database", "Database facts."));

  const result = load(root);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.ok(result.bundle);
  assert.deepEqual(result.bundle.documents.map((document) => document.id), ["api", "db"]);
  assert.deepEqual(result.bundle.documents[0].links.map((link) => [link.kind, link.target]), [
    ["internal", "db"], ["internal", "future"], ["external", "https://example.test"],
  ]);
  assert.match(result.bundle.contentHash, /^[0-9a-f]{64}$/);
  assert.match(result.bundle.documents[0].contentHash, /^[0-9a-f]{64}$/);
  assert.ok(Buffer.byteLength(result.bundle.summary, "utf8") <= OKF_PROVIDER_LIMITS.summaryBytes);
  assert.equal("metadata" in result.bundle.documents[0], false, "OKF-specific frontmatter extensions stay behind the provider boundary instead of becoming runtime fields");
  assert.match(result.bundle.documents[0].content, /producer_extension: kept/, "exact source bytes remain readable");
});

test("OKF document IDs accept the transport-safe byte boundary and reject N+1", (t) => {
  const idWithBytes = (bytes: number): string => {
    const parts: string[] = [];
    while (Buffer.byteLength([...parts, "x".repeat(200)].join("/"), "utf8") <= bytes) parts.push("x".repeat(200));
    const remaining = bytes - Buffer.byteLength(parts.join("/"), "utf8") - (parts.length ? 1 : 0);
    if (remaining > 0) parts.push("x".repeat(remaining));
    return parts.join("/");
  };
  const exactId = idWithBytes(1_716);
  assert.equal(validKnowledgeDocumentId(exactId), true);
  assert.equal(validKnowledgeDocumentId(idWithBytes(1_717)), false);
  if (process.platform === "darwin") {
    t.diagnostic("Darwin PATH_MAX cannot materialize the transport-level maximum as one physical fixture path");
    return;
  }
  const exact = temp();
  write(join(exact, `.pi/hive/knowledge/shared/${exactId}.md`), concept("Reference", "Boundary", "accepted"));
  const accepted = load(exact);
  assert.equal(accepted.ok, true, JSON.stringify(accepted.diagnostics));
  assert.equal(accepted.bundle?.documents[0].id, exactId);

  const overflow = temp();
  write(join(overflow, `.pi/hive/knowledge/shared/${idWithBytes(1_717)}.md`), concept("Reference", "Overflow", "rejected"));
  const rejected = load(overflow);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.diagnostics.some((diagnostic) => diagnostic.code === "OKF_DOCUMENT_ID_INVALID"), true);
});

test("OKF validation fails closed for malformed frontmatter, traversal, symlinks, UTF-8, and size without leaking content", () => {
  const cases: Array<{ name: string; setup(root: string): void; code: string; limits?: Partial<OkfProviderLimits> }> = [
    { name: "frontmatter", setup: (root) => write(join(root, ".pi/hive/knowledge/shared/bad.md"), "---\ntitle: SECRET-TITLE\n---\nSECRET-BODY"), code: "OKF_TYPE_REQUIRED" },
    { name: "link traversal", setup: (root) => write(join(root, ".pi/hive/knowledge/shared/bad.md"), concept("Reference", "Bad", "[escape](../../secret.md)")), code: "OKF_LINK_ESCAPE" },
    { name: "utf8", setup: (root) => write(join(root, ".pi/hive/knowledge/shared/bad.md"), Uint8Array.from([0xff, 0xfe])), code: "OKF_INVALID_UTF8" },
    { name: "size", setup: (root) => write(join(root, ".pi/hive/knowledge/shared/bad.md"), concept("Reference", "Big", "x".repeat(200))), code: "OKF_FILE_TOO_LARGE", limits: { fileBytes: 100 } },
    { name: "symlink", setup: (root) => { write(join(root, ".pi/hive/knowledge/shared/real.md"), concept("Reference", "Real", "safe")); symlinkSync("real.md", join(root, ".pi/hive/knowledge/shared/link.md")); }, code: "OKF_SYMLINK_DENIED" },
  ];
  for (const item of cases) {
    const root = temp(); item.setup(root);
    const result = load(root, ".pi/hive/knowledge/shared", item.limits);
    assert.equal(result.ok, false, item.name);
    assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === item.code), true, `${item.name}: ${JSON.stringify(result.diagnostics)}`);
    assert.equal(JSON.stringify(result.diagnostics).includes("SECRET"), false, `${item.name} diagnostic leaked content`);
    assert.ok(result.diagnostics.length <= OKF_PROVIDER_LIMITS.diagnostics);
  }

  const root = temp();
  const outside = temp(); write(join(outside, "secret.md"), concept("Reference", "Secret", "secret"));
  mkdirSync(join(root, ".pi/hive/knowledge/shared"), { recursive: true });
  symlinkSync(join(outside, "secret.md"), join(root, ".pi/hive/knowledge/shared/escape.md"));
  assert.equal(load(root).diagnostics.some((diagnostic) => diagnostic.code === "OKF_SYMLINK_DENIED"), true);
});

test("OKF link cycles are bounded diagnostics rather than recursive traversal", () => {
  const root = temp();
  write(join(root, ".pi/hive/knowledge/shared/a.md"), concept("Reference", "A", "[B](b.md)"));
  write(join(root, ".pi/hive/knowledge/shared/b.md"), concept("Reference", "B", "[A](a.md)"));
  const result = load(root);
  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.filter((diagnostic) => diagnostic.code === "OKF_LINK_CYCLE").length, 1);
  assert.ok(result.diagnostics.length <= OKF_PROVIDER_LIMITS.diagnostics);
});

test("OKF reserved index/log files enforce the documented bounded v0.1 subset", () => {
  const valid = temp();
  write(join(valid, ".pi/hive/knowledge/shared/doc.md"), concept("Reference", "Document", "Facts."));
  write(join(valid, ".pi/hive/knowledge/shared/index.md"), "---\nokf_version: \"0.1\"\n---\n# Concepts\n\n* [Document](doc.md) - bounded description\n");
  write(join(valid, ".pi/hive/knowledge/shared/log.md"), "# Directory Update Log\n\n## 2026-05-22\n* **Update**: Added [Document](doc.md).\n\n## 2026-05-15\n* Initialized the bundle.\n");
  write(join(valid, ".pi/hive/knowledge/shared/nested/index.md"), "# Nested\n\n* [Document](../doc.md) - parent document\n");
  write(join(valid, ".pi/hive/knowledge/shared/nested/log.md"), "# Directory Update Log\n\n## 2026-01-01\n* Created the directory.\n");
  const accepted = load(valid);
  assert.equal(accepted.ok, true, JSON.stringify(accepted.diagnostics));
  assert.doesNotMatch(accepted.bundle?.summary ?? "", /okf_version/u, "root version frontmatter is provider metadata, not progressive summary content");

  const cases = [
    { name: "root version", path: "index.md", content: "---\nokf_version: \"0.2\"\n---\n# Concepts\n\n* [Document](doc.md) - description\n", code: "OKF_INDEX_INVALID" },
    { name: "nested frontmatter", path: "nested/index.md", content: "---\nokf_version: \"0.1\"\n---\n# Nested\n\n* [Document](../doc.md) - description\n", code: "OKF_INDEX_INVALID" },
    { name: "root parent traversal", path: "index.md", content: "# Concepts\n\n* [Outside](../outside.md) - escape\n", code: "OKF_INDEX_INVALID" },
    { name: "nested parent traversal", path: "nested/index.md", content: "# Nested\n\n* [Outside](../../outside.md) - escape\n", code: "OKF_INDEX_INVALID" },
    { name: "encoded parent traversal", path: "index.md", content: "# Concepts\n\n* [Outside](%2e%2e/%2e%2e/outside.md) - escape\n", code: "OKF_INDEX_INVALID" },
    { name: "backslash traversal", path: "index.md", content: "# Concepts\n\n* [Outside](..\\..\\outside.md) - escape\n", code: "OKF_INDEX_INVALID" },
    { name: "malformed index prose", path: "index.md", content: "this is not an OKF index entry list\n", code: "OKF_INDEX_INVALID" },
    { name: "invalid log date", path: "log.md", content: "# Directory Update Log\n\n## definitely-not-an-iso-date\n* update\n", code: "OKF_LOG_INVALID" },
    { name: "invalid calendar date", path: "log.md", content: "# Directory Update Log\n\n## 2026-02-30\n* update\n", code: "OKF_LOG_INVALID" },
    { name: "non-list log entry", path: "log.md", content: "# Directory Update Log\n\n## 2026-01-01\nplain prose\n", code: "OKF_LOG_INVALID" },
  ] as const;
  for (const item of cases) {
    const root = temp();
    write(join(root, ".pi/hive/knowledge/shared/doc.md"), concept("Reference", "Document", "Facts."));
    write(join(root, `.pi/hive/knowledge/shared/${item.path}`), item.content);
    const result = load(root);
    assert.equal(result.ok, false, item.name);
    assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === item.code), true, `${item.name}: ${JSON.stringify(result.diagnostics)}`);
  }

  const overIndex = temp();
  write(join(overIndex, ".pi/hive/knowledge/shared/doc.md"), concept("Reference", "Document", "Facts."));
  write(join(overIndex, ".pi/hive/knowledge/shared/index.md"), `# Concepts\n\n${"* [Document](doc.md) - description\n".repeat(3)}`);
  assert.equal(load(overIndex, ".pi/hive/knowledge/shared", { indexEntries: 2 } as Partial<OkfProviderLimits>).diagnostics.some((item) => item.code === "OKF_INDEX_LIMIT_EXCEEDED"), true);

  const overLog = temp();
  write(join(overLog, ".pi/hive/knowledge/shared/doc.md"), concept("Reference", "Document", "Facts."));
  write(join(overLog, ".pi/hive/knowledge/shared/log.md"), `# Directory Update Log\n\n## 2026-01-01\n${"* update\n".repeat(3)}`);
  assert.equal(load(overLog, ".pi/hive/knowledge/shared", { logEntries: 2 } as Partial<OkfProviderLimits>).diagnostics.some((item) => item.code === "OKF_LOG_LIMIT_EXCEEDED"), true);
});

test("OKF provider rejects an aggregate N+1 file before shared reservation or content read allocation", () => {
  const root = temp();
  const source = concept("Reference", "Document", "bounded content");
  write(join(root, ".pi/hive/knowledge/shared/doc.md"), source);
  const reservations: number[] = [];
  const result = loadOkfBundle({
    projectRoot: root,
    declaration: { id: "shared", providerId: "okf", path: ".pi/hive/knowledge/shared", updatePolicy: "reviewed" },
    limits: { fileBytes: Buffer.byteLength(source, "utf8"), aggregateBytes: Buffer.byteLength(source, "utf8") - 1 },
    reserveContentBytes: (bytes) => reservations.push(bytes),
  });
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "OKF_AGGREGATE_TOO_LARGE"), true);
  assert.deepEqual(reservations, [], "provider-local aggregate rejection must precede outer reservation/allocation/read");
});

test("descriptor-rooted OKF traversal contains deterministic ancestor, root, and nested symlink replacement races", () => {
  const run = (kind: "ancestor" | "root" | "nested") => {
    const projectRoot = temp();
    const bundleRoot = join(projectRoot, ".pi/hive/knowledge/shared");
    write(join(bundleRoot, "safe.md"), concept("Reference", "Safe", "SAFE-CONTENT"));
    if (kind === "nested") write(join(bundleRoot, "nested/local.md"), concept("Reference", "Local", "LOCAL-CONTENT"));
    const outside = temp();
    write(join(outside, "secret.md"), concept("Reference", "Secret", "TOP-SECRET-CONTENT"));
    let injected = false;
    const result = loadOkfBundle({
      projectRoot,
      declaration: { id: "shared", providerId: "okf", path: ".pi/hive/knowledge/shared", updatePolicy: "reviewed" },
      operations: {
        fault(point, relativePath) {
          if (injected) return;
          if (kind === "ancestor" && point === "before-directory-open" && relativePath === ".pi/hive/knowledge") {
            renameSync(join(projectRoot, ".pi/hive/knowledge"), join(projectRoot, ".pi/hive/knowledge-original"));
            symlinkSync(outside, join(projectRoot, ".pi/hive/knowledge"));
            injected = true;
          } else if (kind === "root" && point === "after-root-pinned") {
            renameSync(bundleRoot, `${bundleRoot}-original`);
            symlinkSync(outside, bundleRoot);
            injected = true;
          } else if (kind === "nested" && point === "after-directory-listed" && relativePath === "nested") {
            renameSync(join(bundleRoot, "nested"), join(bundleRoot, "nested-original"));
            symlinkSync(outside, join(bundleRoot, "nested"));
            injected = true;
          }
        },
      },
    });
    assert.equal(injected, true, `${kind} fault seam did not run`);
    assert.equal(result.ok, false, `${kind} identity swap must fail closed even when traversal remains descriptor-contained`);
    assert.equal(JSON.stringify(result).includes("TOP-SECRET-CONTENT"), false, `${kind} race leaked outside content`);
    assert.equal(result.bundle?.documents.some((document) => document.title === "Secret") ?? false, false, `${kind} race indexed outside content`);
  };
  run("ancestor");
  run("root");
  run("nested");
});
