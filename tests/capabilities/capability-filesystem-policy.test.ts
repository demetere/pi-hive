import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  authorizeFilesystemOperation,
  classifyFilesystemToolCall,
  compileFilesystemPolicy,
  createFilesystemPolicyHook,
  trustedStatAndHash,
} from "../../src/capabilities/filesystem.ts";
import { normalizeCapabilities } from "../../src/capabilities/policy.ts";
import { DEFAULT_PROTECTED_PATHS, checkProtectedPath } from "../../src/capabilities/reserved-paths.ts";
import type { EffectiveNodePolicy, FilesystemOperation } from "../../src/capabilities/types.ts";

function effective(filesystem: EffectiveNodePolicy["capabilities"]["filesystem"]): EffectiveNodePolicy {
  return {
    workflowId: "delivery",
    nodeId: "builder",
    agentId: "generalist",
    capabilities: { ...normalizeCapabilities({}), filesystem },
    provenance: Object.freeze({
      filesystem: Object.freeze(["agent-ceiling", "workflow-node"]), shell: Object.freeze(["agent-ceiling", "workflow-node-omitted-deny"]),
      git: Object.freeze(["agent-ceiling", "workflow-node-omitted-deny"]), "external-network": Object.freeze(["agent-ceiling", "workflow-node-omitted-deny"]),
      "human-input": Object.freeze(["agent-ceiling", "workflow-node-omitted-deny"]), artifact: Object.freeze(["agent-ceiling", "workflow-node-omitted-deny"]),
      knowledge: Object.freeze(["agent-ceiling", "workflow-node-omitted-deny"]),
    }) as EffectiveNodePolicy["provenance"],
    tools: Object.freeze(["read", "write"]), budgets: Object.freeze({}), skills: Object.freeze([]), knowledge: Object.freeze([]), directMemberIds: Object.freeze([]),
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-fs-policy-"));
  mkdirSync(join(root, "workspace", "private"), { recursive: true });
  mkdirSync(join(root, "workspace", "dir"), { recursive: true });
  writeFileSync(join(root, "workspace", "existing.txt"), "visible value");
  writeFileSync(join(root, "workspace", "private", "secret.txt"), "secret value");
  const capabilities = normalizeCapabilities({
    filesystem: [{ path: ".", operations: ["read", "create", "update", "delete"], include: ["workspace/**"], exclude: ["workspace/private/**"] }],
  });
  return { root, policy: compileFilesystemPolicy({ projectRoot: root, effectivePolicy: effective(capabilities.filesystem) }) };
}

function decision(policy: ReturnType<typeof compileFilesystemPolicy>, operation: FilesystemOperation, path: string) {
  return authorizeFilesystemOperation(policy, { operation, path });
}

test("filesystem policy distinguishes read/create/update/delete and existence", () => {
  const { policy } = fixture();
  const rows: Array<[FilesystemOperation, string, boolean]> = [
    ["read", "workspace/existing.txt", true], ["read", "workspace/dir", true], ["read", "workspace/missing.txt", false],
    ["create", "workspace/new.txt", true], ["create", "workspace/new-dir", true], ["create", "workspace/existing.txt", false],
    ["update", "workspace/existing.txt", true], ["update", "workspace/dir", true], ["update", "workspace/missing.txt", false],
    ["delete", "workspace/existing.txt", true], ["delete", "workspace/dir", true], ["delete", "workspace/missing.txt", false],
  ];
  for (const [operation, path, expected] of rows) assert.equal(decision(policy, operation, path).ok, expected, `${operation} ${path}`);

  const readOnly = normalizeCapabilities({ filesystem: [{ path: "workspace", operations: ["read"] }] });
  const compiled = compileFilesystemPolicy({ projectRoot: policy.projectRoot, effectivePolicy: effective(readOnly.filesystem) });
  assert.equal(decision(compiled, "read", "workspace/existing.txt").ok, true);
  for (const operation of ["create", "update", "delete"] as const) assert.equal(decision(compiled, operation, "workspace/existing.txt").ok, false);
});

test("filesystem filters are scope-relative, exclusions always win, and diagnostics retain bounded provenance", () => {
  const { policy } = fixture();
  assert.equal(decision(policy, "read", "workspace/existing.txt").ok, true);
  const denied = decision(policy, "read", "workspace/private/secret.txt");
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "FILESYSTEM_SCOPE_DENIED");
  assert.doesNotMatch(denied.reason, /secret\.txt|secret value/);
  assert.match(denied.reason, /delivery\/builder/);
  assert.ok(Buffer.byteLength(denied.reason, "utf8") <= 2_048);

  const scoped = normalizeCapabilities({ filesystem: [{ path: "workspace", operations: ["read"], include: ["*.txt"], exclude: ["private/**"] }] });
  const compiled = compileFilesystemPolicy({ projectRoot: policy.projectRoot, effectivePolicy: effective(scoped.filesystem) });
  assert.equal(decision(compiled, "read", "workspace/existing.txt").ok, true);
  assert.equal(decision(compiled, "read", "workspace/dir").ok, false);
});

test("filesystem canonicalization rejects traversal and symlink escape at target, intermediate, and missing-tail ancestors", () => {
  const { root, policy } = fixture();
  const outside = mkdtempSync(join(tmpdir(), "pi-hive-fs-outside-"));
  writeFileSync(join(outside, "outside.txt"), "outside");
  symlinkSync(join(root, "workspace", "existing.txt"), join(root, "workspace", "inside-link"));
  symlinkSync(join(outside, "outside.txt"), join(root, "workspace", "target-escape"));
  symlinkSync(outside, join(root, "workspace", "dir-escape"));

  assert.equal(decision(policy, "read", "workspace/inside-link").ok, true);
  assert.equal(decision(policy, "read", "workspace/target-escape").ok, false);
  assert.equal(decision(policy, "create", "workspace/dir-escape/new.txt").ok, false);
  assert.equal(decision(policy, "create", "workspace/../escape.txt").ok, false);
  assert.equal(decision(policy, "read", join(outside, "outside.txt")).ok, false);
});

test("all protected subsystem and credential roots override a broad generic grant", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-fs-reserved-"));
  const broad = normalizeCapabilities({ filesystem: [{ path: ".", operations: ["read", "create", "update", "delete"] }] });
  const policy = compileFilesystemPolicy({ projectRoot: root, effectivePolicy: effective(broad.filesystem), secretPaths: ["custom/secret-store"] });
  const paths = [
    ".pi/hive/hive-config.yaml", ".pi/hive/workflows/build.yaml", ".pi/hive/agents/a.md", ".pi/hive/skills/x/SKILL.md",
    ".pi/hive/knowledge/shared/knowledge.md", ".pi/hive/sessions/run/journal.jsonl", ".pi/hive/telemetry/events.jsonl",
    ".pi/hive/dashboard-auth/token", "openspec/changes/x/tasks.md", ".git/config", ".env.local", ".npmrc", "keys/id_ed25519",
    "custom/secret-store/token.json",
  ];
  for (const path of paths) {
    assert.equal(decision(policy, "create", path).ok, false, path);
    assert.equal(checkProtectedPath(root, path, { allowMissing: true, secretPaths: ["custom/secret-store"] }).protected, true, path);
  }
  assert.ok(DEFAULT_PROTECTED_PATHS.length >= 8);
});

test("direct and re-enabled file tools are classified and independently policy checked", async () => {
  const { policy } = fixture();
  assert.deepEqual(classifyFilesystemToolCall("read", { path: "workspace/existing.txt" }, policy), [{ operation: "read", path: "workspace/existing.txt" }]);
  assert.deepEqual(classifyFilesystemToolCall("write", { path: "workspace/new.txt" }, policy), [{ operation: "create", path: "workspace/new.txt" }]);
  assert.deepEqual(classifyFilesystemToolCall("write", { path: "workspace/existing.txt" }, policy), [{ operation: "update", path: "workspace/existing.txt" }]);
  assert.deepEqual(classifyFilesystemToolCall("edit", { path: "workspace/missing.txt" }, policy), [{ operation: "update", path: "workspace/missing.txt" }]);
  assert.deepEqual(classifyFilesystemToolCall("delete", { path: "workspace/existing.txt" }, policy), [{ operation: "delete", path: "workspace/existing.txt" }]);

  const hook = createFilesystemPolicyHook(policy);
  assert.equal(await hook({ toolName: "read", input: { path: "workspace/existing.txt" } }), undefined);
  const blocked = await hook({ toolName: "read", input: { path: "workspace/private/secret.txt" } });
  assert.equal(blocked?.block, true);
  assert.doesNotMatch(blocked?.reason ?? "", /secret\.txt/);
  assert.equal((await hook({ toolName: "read", input: {} }))?.block, true, "recognized direct tools require an explicit target");
  assert.equal((await hook({ toolName: "write", input: {} }))?.block, true, "pathless writes must fail closed");
  assert.equal(await hook({ toolName: "foreign_tool", input: { path: "workspace/private/secret.txt" } }), undefined);
});

test("trusted stat/hash remains project-contained and exposes no file content", () => {
  const { root } = fixture();
  const result = trustedStatAndHash(root, "workspace/existing.txt");
  assert.equal(result.ok, true);
  assert.equal(result.kind, "file");
  assert.match(result.sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes("visible value"), false);
  assert.equal("content" in result, false);
  assert.equal(trustedStatAndHash(root, "../outside.txt").ok, false);
});

test("first release rejects non-Linux filesystem policy activation explicitly", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-fs-platform-"));
  const broad = normalizeCapabilities({ filesystem: [{ path: ".", operations: ["read"] }] });
  assert.throws(() => compileFilesystemPolicy({ projectRoot: root, effectivePolicy: effective(broad.filesystem), platform: "win32" }), /FILESYSTEM_PLATFORM_UNSUPPORTED/);
});
