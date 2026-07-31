import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isCapabilitySubset,
  normalizeCapabilities,
  resolveCapabilityOverlay,
} from "../../src/capabilities/policy.ts";
import { resolveEffectiveNodePolicy } from "../../src/capabilities/resolve.ts";
import type { CapabilityDeclaration } from "../../src/capabilities/types.ts";

const ceiling: CapabilityDeclaration = {
  filesystem: [{ path: ".", operations: ["read", "create", "update"], include: ["src/**", "tests/**"], exclude: ["**/.env*", "**/secrets/**"] }],
  shell: ["inspect", "test", "execute-code"],
  git: true,
  "external-network": true,
  "human-input": true,
  artifact: ["read", "write", "review"],
  knowledge: ["read", "propose", "curate"],
};

const emptySubsystems = { artifactAvailable: false, knowledgeAvailable: false, questionsAvailable: false } as const;

test("capability overlays are default-deny by present group object and mechanically narrower", () => {
  const inherited = resolveCapabilityOverlay(ceiling, undefined);
  assert.equal(inherited.ok, true);
  assert.equal(inherited.policy?.git, true);

  const narrowed = resolveCapabilityOverlay(ceiling, {
    filesystem: [{ path: ".", operations: ["read"], include: ["src/**"], exclude: ["**/.env*", "**/secrets/**", "src/generated/**"] }],
    shell: ["inspect"],
  });
  assert.equal(narrowed.ok, true);
  assert.deepEqual(narrowed.policy?.shell, ["inspect"]);
  assert.equal(narrowed.policy?.git, false);
  assert.deepEqual(narrowed.policy?.artifact, []);
  assert.equal(isCapabilitySubset(narrowed.policy!, normalizeCapabilities(ceiling)), true);
});

test("every authority group rejects widening and unknown authority values fail closed", () => {
  const attempts: Array<{ ceiling: CapabilityDeclaration; overlay: CapabilityDeclaration }> = [
    { ceiling: { shell: ["inspect"] }, overlay: { shell: ["package"] } },
    { ceiling: { filesystem: [{ path: ".", operations: ["read"] }] }, overlay: { filesystem: [{ path: ".", operations: ["delete"] }] } },
    { ceiling: { filesystem: [{ path: ".", operations: ["read"], include: ["src/**"] }] }, overlay: { filesystem: [{ path: "docs", operations: ["read"], include: ["docs/**"] }] } },
    { ceiling: {}, overlay: { git: true } },
    { ceiling: {}, overlay: { "external-network": true } },
    { ceiling: {}, overlay: { "human-input": true } },
    { ceiling: { artifact: ["read"] }, overlay: { artifact: ["write"] } },
    { ceiling: { knowledge: ["read"] }, overlay: { knowledge: ["curate"] } },
  ];
  for (const attempt of attempts) {
    const result = resolveCapabilityOverlay(attempt.ceiling, attempt.overlay);
    assert.equal(result.ok, false, JSON.stringify(attempt));
    assert.match(result.issues[0]?.code ?? "", /^CAPABILITY_/);
  }
  for (const invalid of [
    { mystery: true },
    { shell: ["root-shell"] },
    { filesystem: [{ path: "../escape", operations: ["read"] }] },
    { filesystem: [{ path: ".", operations: ["read"], include: ["!src/**"] }] },
  ]) {
    const result = resolveCapabilityOverlay(invalid as CapabilityDeclaration, undefined);
    assert.equal(result.ok, false, JSON.stringify(invalid));
    assert.equal(result.issues[0]?.code, "CAPABILITY_VALUE_INVALID");
  }
});

test("filesystem exclusions win, exact duplicates dedupe, and proof retains catalog clause identity", () => {
  const accepted = resolveCapabilityOverlay(ceiling, { filesystem: [{ path: ".", operations: ["read"], include: ["src/**"], exclude: ["**/.env*", "**/secrets/**", "src/private/**"] }] });
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.policy?.filesystem[0].exclude, ["**/.env*", "**/secrets/**", "src/private/**"]);

  const duplicateCeiling: CapabilityDeclaration = {
    filesystem: [
      { path: "z", operations: ["read"] },
      { path: "a", operations: ["read"] },
      { path: "z", operations: ["read"] },
    ],
  };
  const normalized = normalizeCapabilities(duplicateCeiling);
  assert.deepEqual(normalized.filesystem.map(({ path, ceilingClause }) => [path, ceilingClause]), [["a", 1], ["z", 0]]);
  const proven = resolveCapabilityOverlay(duplicateCeiling, { filesystem: [{ path: "z", operations: ["read"] }] });
  assert.equal(proven.ok, true);
  assert.equal(proven.policy?.filesystem[0].ceilingClause, 0);

  const grants = Array.from({ length: 257 }, (_, index) => ({ path: `p${index}`, operations: ["read"] as const }));
  const bounded = resolveCapabilityOverlay({ filesystem: grants }, { filesystem: grants });
  assert.equal(bounded.ok, false);
  assert.equal(bounded.issues[0]?.code, "CAPABILITY_CLAUSE_LIMIT_EXCEEDED");
});

test("representative overlay combinations accept only mechanically proven subsets", () => {
  const booleanOverlays = [
    {},
    { git: false },
    { git: true, "external-network": false, "human-input": true },
  ] as const;
  const shellOverlays = [undefined, [], ["inspect"], ["inspect", "test"]] as const;
  const artifactOverlays = [undefined, [], ["read"], ["read", "review"]] as const;
  const knowledgeOverlays = [undefined, [], ["read"], ["read", "propose"]] as const;
  const filesystemOverlays: Array<CapabilityDeclaration["filesystem"]> = [
    undefined,
    [],
    [{ path: ".", operations: ["read"], include: ["src/**"], exclude: ["**/.env*", "**/secrets/**", "src/private/**"] }],
    [{ path: ".", operations: ["read", "update"], include: ["tests/**"], exclude: ["**/.env*", "**/secrets/**"] }],
  ];
  const normalizedCeiling = normalizeCapabilities(ceiling);
  let accepted = 0;
  for (const booleans of booleanOverlays) for (const shell of shellOverlays) for (const artifact of artifactOverlays) for (const knowledge of knowledgeOverlays) for (const filesystem of filesystemOverlays) {
    const overlay: CapabilityDeclaration = {
      ...booleans,
      ...(shell !== undefined ? { shell } : {}),
      ...(artifact !== undefined ? { artifact } : {}),
      ...(knowledge !== undefined ? { knowledge } : {}),
      ...(filesystem !== undefined ? { filesystem } : {}),
    };
    const result = resolveCapabilityOverlay(ceiling, overlay);
    assert.equal(result.ok, true, JSON.stringify(overlay));
    assert.ok(result.policy);
    assert.equal(isCapabilitySubset(result.policy, normalizedCeiling), true, JSON.stringify(overlay));
    accepted += 1;
  }
  assert.equal(accepted, 768);
});

test("filesystem path and filter proof rejects every ambiguous widening matrix row", () => {
  const filesystemCeiling: CapabilityDeclaration = {
    filesystem: [{ path: "workspace", operations: ["read", "update"], include: ["src/**", "tests/**"], exclude: ["**/.env*", "**/secrets/**"] }],
  };
  const rows: Array<{ grant: NonNullable<CapabilityDeclaration["filesystem"]>[number]; accepted: boolean }> = [
    { grant: { path: "workspace", operations: ["read"], include: ["src/**"], exclude: ["**/.env*", "**/secrets/**", "src/private/**"] }, accepted: true },
    { grant: { path: "workspace/subdir", operations: ["read"], include: ["src/**"], exclude: ["**/.env*", "**/secrets/**"] }, accepted: true },
    { grant: { path: ".", operations: ["read"], include: ["src/**"], exclude: ["**/.env*", "**/secrets/**"] }, accepted: false },
    { grant: { path: "workspace-sibling", operations: ["read"], include: ["src/**"], exclude: ["**/.env*", "**/secrets/**"] }, accepted: false },
    { grant: { path: "workspace", operations: ["delete"], include: ["src/**"], exclude: ["**/.env*", "**/secrets/**"] }, accepted: false },
    { grant: { path: "workspace", operations: ["read"], include: ["**"], exclude: ["**/.env*", "**/secrets/**"] }, accepted: false },
    { grant: { path: "workspace", operations: ["read"], include: ["src/**"], exclude: ["**/.env*"] }, accepted: false },
    { grant: { path: "workspace/../escape", operations: ["read"], include: ["src/**"], exclude: ["**/.env*", "**/secrets/**"] }, accepted: false },
    { grant: { path: "workspace/*", operations: ["read"], include: ["src/**"], exclude: ["**/.env*", "**/secrets/**"] }, accepted: false },
    { grant: { path: "workspace", operations: ["read"], include: ["!src/**"], exclude: ["**/.env*", "**/secrets/**"] }, accepted: false },
  ];
  for (const { grant, accepted } of rows) {
    const result = resolveCapabilityOverlay(filesystemCeiling, { filesystem: [grant] });
    assert.equal(result.ok, accepted, JSON.stringify(grant));
    if (result.ok && result.policy) assert.equal(isCapabilitySubset(result.policy, normalizeCapabilities(filesystemCeiling)), true);
  }
});

test("repeated catalog identities resolve independently with deterministic attachments and root-only persisted choices", () => {
  const root = resolveEffectiveNodePolicy({
    workflowId: "wf", nodeId: "root", agentId: "same", root: true, directMembers: ["leaf"], ceiling,
    overlay: { shell: ["inspect"] }, budgets: { marker: "root" }, skills: ["two", "one", "one"], knowledge: [],
    projectModel: "provider/project", agentModel: "provider/agent", nodeModel: "inherit", persistedRootModel: "provider/session",
    projectThinking: "low", agentThinking: "medium", persistedRootThinking: "high", ...emptySubsystems,
  });
  const leaf = resolveEffectiveNodePolicy({
    workflowId: "wf", nodeId: "leaf", agentId: "same", root: false, directMembers: [], ceiling,
    overlay: { filesystem: [{ path: ".", operations: ["read"], include: ["tests/**"], exclude: ["**/.env*", "**/secrets/**"] }] },
    budgets: { marker: "leaf" }, skills: [], knowledge: ["k"], projectModel: "provider/project", agentModel: "provider/agent",
    persistedRootModel: "must/not/apply", persistedRootThinking: "must-not-apply", ...emptySubsystems,
  });
  assert.equal(root.ok, true);
  assert.equal(leaf.ok, true);
  assert.notDeepEqual(root.policy?.capabilities, leaf.policy?.capabilities);
  assert.deepEqual(root.policy?.skills, ["one", "two"]);
  assert.equal(root.policy?.model, "provider/session");
  assert.equal(root.policy?.thinking, "high");
  assert.equal(leaf.policy?.model, "provider/agent");
  assert.notEqual(leaf.policy?.thinking, "must-not-apply");
  assert.deepEqual(root.policy?.provenance.shell, ["agent-ceiling", "workflow-node"]);
  assert.deepEqual(leaf.policy?.provenance.shell, ["agent-ceiling", "workflow-node-omitted-deny"]);
});

test("effective node policies are deeply immutable and detach caller-owned inputs", () => {
  const budgets = { node: { turns: 4 } };
  const result = resolveEffectiveNodePolicy({ workflowId: "wf", nodeId: "root", agentId: "agent", root: true, directMembers: [], ceiling, budgets, skills: ["s"], knowledge: [], ...emptySubsystems });
  assert.equal(result.ok, true);
  budgets.node.turns = 9;
  assert.equal((result.policy?.budgets.node as { turns: number }).turns, 4);
  assert.equal(Object.isFrozen(result.policy?.budgets.node), true);
  assert.throws(() => { (result.policy!.budgets.node as { turns: number }).turns = 7; }, /read only|frozen|assign/i);
  assert.equal(JSON.stringify(result.policy).includes("agent-type"), false);
});
