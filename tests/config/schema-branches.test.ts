import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAgentTypes, validateHiveConfigShape } from "../../src/core/schema.ts";

function agent(name = "Lead", overrides: Record<string, any> = {}): any {
  return {
    name, slug: name.toLowerCase().replace(/\s+/g, "-"), path: `${name}.md`, role: "lead",
    agentType: "lead", routingTags: [], responsibilities: [], context: [], skills: [], domain: [],
    members: [], children: [], ...overrides,
  };
}

function config(overrides: Record<string, any> = {}): any {
  return {
    orchestrator: agent("Orchestrator", { role: "orchestrator" }),
    agents: [], sharedContext: [], settings: {}, ...overrides,
  };
}

test("schema accepts every optional governance, domain, and nested-agent field", () => {
  const member = agent("Member", {
    role: "member", agentType: "planner", stages: ["proposal", "design", "specs", "tasks"],
    network: true, commit: "Commit verified work.", color: "#aBc123",
    routingTags: ["plan"], responsibilities: ["author"],
    context: [{ path: "docs/context.md" }], skills: [{ path: "skills/test/SKILL.md" }],
    domain: [{ path: "src", read: true, upsert: false, delete: false, include: ["**/*.ts"], exclude: ["**/*.key"] }],
    governance: { timeoutMs: 1, maxDelegationDepth: 2, maxRuns: 3, tokenBudget: 4, costBudgetUsd: 5, distillerRuns: 6 },
  });
  const child = agent("Child", { role: "member", agentType: "coder" });
  const lead = agent("Lead", { members: [member], children: [child] });
  const value = config({
    agents: [lead],
    sharedContext: [{ path: "README.md" }],
    settings: {
      subagentOutputLimit: 100, maxParallel: 2, queueSize: 3,
      worker: { timeoutMs: 1, maxDelegationDepth: 2, maxRuns: 3, tokenBudget: 4, costBudgetUsd: 5, distillerRuns: 6 },
      teamBudgets: { maxRuns: 10, tokenBudget: 20, costBudgetUsd: 30 },
      secretPaths: [".env", "keys/*.pem"],
      distiller: { enabled: false, conversationLines: 20 },
    },
  });
  assert.doesNotThrow(() => validateHiveConfigShape(value));
  assert.doesNotThrow(() => validateAgentTypes(value));
});

test("shape validation rejects malformed optional collections and scalar fields", () => {
  const invalid: Array<[any, RegExp]> = [
    [null, /must be an object/],
    [[], /must be an object/],
    [config({ orchestrator: agent("", { name: "" }) }), /name must be a non-empty string/],
    [config({ orchestrator: agent("O", { path: "" }) }), /path must be a non-empty string/],
    [config({ orchestrator: agent("O", { slug: "" }) }), /slug must be a non-empty string/],
    [config({ orchestrator: agent("O", { context: "bad" }) }), /context must be a list/],
    [config({ orchestrator: agent("O", { context: [null] }) }), /context\[0\] must be an object/],
    [config({ orchestrator: agent("O", { skills: [{ path: "" }] }) }), /skills\[0\]\.path/],
    [config({ orchestrator: agent("O", { domain: "bad" }) }), /domain must be a list/],
    [config({ orchestrator: agent("O", { domain: [null] }) }), /domain\[0\] must be an object/],
    [config({ orchestrator: agent("O", { domain: [{ path: "src", read: true, upsert: false }] }) }), /delete must be explicitly/],
    [config({ orchestrator: agent("O", { domain: [{ path: "src", read: "yes", upsert: false, delete: false }] }) }), /read must be explicitly/],
    [config({ orchestrator: agent("O", { members: "bad" }) }), /members must be a list/],
    [config({ orchestrator: agent("O", { children: "bad" }) }), /children must be a list/],
    [config({ sharedContext: "bad" }), /shared_context must be a list/],
    [config({ agents: "bad" }), /agents must be a list/],
    [config({ settings: "bad" }), /settings must be an object/],
    [config({ settings: { maxParallel: Number.NaN } }), /finite number/],
    [config({ settings: { worker: [] } }), /worker must be an object/],
    [config({ settings: { teamBudgets: [] } }), /teamBudgets must be an object/],
    [config({ settings: { secretPaths: [""] } }), /secretPaths\[0\]/],
    [config({ settings: { distiller: { enabled: "yes" } } }), /enabled must be true or false/],
  ];
  for (const [value, expected] of invalid) assert.throws(() => validateHiveConfigShape(value), expected);
});

test("agent-type validation rejects every malformed capability contract", () => {
  const invalid: Array<[Record<string, any>, RegExp]> = [
    [{ agentType: undefined }, /agent-type is required/],
    [{ agentType: null }, /agent-type is required/],
    [{ agentType: " " }, /agent-type is required/],
    [{ agentType: "wizard" }, /must be one of/],
    [{ agentType: "planner", stages: "proposal" }, /stages must be a list/],
    [{ agentType: "coder", stages: ["proposal"] }, /only valid on an agent-type: planner/],
    [{ agentType: "planner", stages: ["ship"] }, /stages\[0\] must be one of/],
    [{ agentType: "coder", network: "yes" }, /network must be true or false/],
    [{ agentType: "coder", commit: "" }, /commit must be a non-empty string/],
  ];
  for (const [overrides, expected] of invalid) {
    assert.throws(() => validateAgentTypes(config({ orchestrator: agent("Orchestrator", overrides) })), expected);
  }
  assert.doesNotThrow(() => validateAgentTypes(config({ orchestrator: agent("Orchestrator"), agents: undefined })));
});
