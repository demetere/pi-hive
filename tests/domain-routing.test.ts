import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashMutationKind, domainAllows, enforceDomainForTool, pathWithin } from "../src/engine/domain.ts";
import { routeAgents } from "../src/engine/routing.ts";
import { runAsAgent } from "../src/engine/session.ts";
import { buildOrchestratorPrompt } from "../src/agents/prompts.ts";
import type { AgentConfig, AgentRuntime, HiveState } from "../src/core/types.ts";

function runtime(name: string, extra: Partial<AgentRuntime["config"]> = {}): AgentRuntime {
  return {
    config: {
      name,
      path: `${name}.md`,
      role: "member",
      routingTags: [],
      domain: [],
      ...extra,
    },
    systemPrompt: "",
    status: "idle",
    task: "",
    lastWork: "",
    toolCount: 0,
    elapsedMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    contextPct: 0,
    runCount: 0,
    sessionFile: "",
  };
}

function stateWith(runtimes: AgentRuntime[]): HiveState {
  return {
    pi: {} as any,
    config: null,
    session: null,
    runtimes: new Map(runtimes.map((entry) => [entry.config.name.toLowerCase(), entry])),
    widgetCtx: null,
    activeRuns: 0,
    mode: "hive",
    normalToolNames: [],
    sddStatus: null,
    obsSeq: 0,
  };
}

test("domainAllows uses most-specific-wins with deny tie-breaks", () => {
  const ctx = { cwd: "/repo" } as any;
  const agent = runtime("Frontend Dev", {
    domain: [
      { path: "ui", read: true, upsert: true, delete: false },
      { path: "ui/secrets", read: true, upsert: false, delete: false },
    ],
  });

  assert.equal(pathWithin("/repo/ui", "/repo/ui/src/App.tsx"), true);
  assert.equal(domainAllows(ctx, agent, "ui/src/App.tsx", "upsert"), true);
  assert.equal(domainAllows(ctx, agent, "ui/secrets/token.ts", "upsert"), false);
  assert.equal(domainAllows(ctx, agent, "server/index.ts", "read"), false);
});

test("domainAllows applies include globs more specifically than catch-all denies", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-domain-"));
  mkdirSync(join(cwd, "backend/patient"), { recursive: true });
  writeFileSync(join(cwd, "backend/patient/search_test.go"), "package patient");
  writeFileSync(join(cwd, "backend/patient/search.go"), "package patient");
  const ctx = { cwd } as any;
  const agent = runtime("Core Tester", {
    domain: [
      { path: "backend", read: true, upsert: false, delete: false },
      { path: "backend", read: true, upsert: true, delete: false, include: ["**/*_test.go"] },
    ],
  });

  assert.equal(domainAllows(ctx, agent, "backend/patient/search_test.go", "read"), true);
  assert.equal(domainAllows(ctx, agent, "backend/patient/search_test.go", "upsert"), true);
  assert.equal(domainAllows(ctx, agent, "backend/patient/search.go", "read"), true);
  assert.equal(domainAllows(ctx, agent, "backend/patient/search.go", "upsert"), false);
});

test("domainAllows rejects existing and new targets through an escaping symlink", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-domain-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "pi-hive-domain-outside-"));
  mkdirSync(join(cwd, "allowed"));
  writeFileSync(join(cwd, "allowed/inside.txt"), "inside");
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(outside, join(cwd, "allowed/escape"));
  symlinkSync(outside, join(cwd, "linked-domain"));
  const ctx = { cwd } as any;
  const agent = runtime("Symlink Tester", {
    domain: [{ path: "allowed", read: true, upsert: true, delete: true }],
  });

  assert.equal(domainAllows(ctx, agent, "allowed/inside.txt", "read"), true);
  assert.equal(domainAllows(ctx, agent, "allowed/escape/secret.txt", "read"), false);
  assert.equal(domainAllows(ctx, agent, "allowed/escape/new.txt", "upsert"), false);
  assert.equal(domainAllows(ctx, agent, "allowed/escape/secret.txt", "delete"), false);
  const linkedRootAgent = runtime("Linked Root", {
    domain: [{ path: "linked-domain", read: true, upsert: true, delete: true }],
  });
  assert.equal(domainAllows(ctx, linkedRootAgent, "linked-domain/secret.txt", "read"), false);
  assert.equal(domainAllows(ctx, linkedRootAgent, "linked-domain/new.txt", "upsert"), false);
});

test("domainAllows honors exclude globs", () => {
  const ctx = { cwd: "/repo" } as any;
  const agent = runtime("Backend Dev", {
    domain: [
      { path: "backend", read: true, upsert: true, delete: false, exclude: ["generated/**"] },
      { path: "backend/generated", read: true, upsert: false, delete: false },
    ],
  });

  assert.equal(domainAllows(ctx, agent, "backend/api/server.go", "upsert"), true);
  assert.equal(domainAllows(ctx, agent, "backend/generated/client.go", "upsert"), false);
});

test("enforceDomainForTool blocks mutating bash outside explicit domains", () => {
  const ctx = { cwd: "/repo" } as any;
  const state = stateWith([runtime("Frontend Dev", { domain: [{ path: "ui", read: true, upsert: true, delete: false }] })]);

  assert.equal(bashMutationKind("rm ui/App.tsx"), "delete");
  runAsAgent("Frontend Dev", () => {
    assert.match(enforceDomainForTool(state, { toolName: "bash", input: { command: "rm ui/App.tsx" } }, ctx)?.reason ?? "", /cannot delete/);
    assert.equal(enforceDomainForTool(state, { toolName: "bash", input: { command: "touch ui/App.tsx" } }, ctx), undefined);
  });
});

test("routeAgents scores specialists and respects delegation hierarchy", () => {
  const state = stateWith([
    runtime("Orchestrator", { role: "orchestrator", allowedAgents: ["Frontend Dev", "Backend Dev"] }),
    runtime("Frontend Dev", { role: "lead", groupName: "Engineering", routingTags: ["react", "css"] }),
    runtime("Backend Dev", { role: "lead", groupName: "Engineering", routingTags: ["api", "database"] }),
    runtime("Security Reviewer", { role: "member", groupName: "Validation", routingTags: ["security"] }),
  ]);

  const matches = runAsAgent("Orchestrator", () => routeAgents(state, "fix the React CSS component", 3));
  assert.equal(matches[0].name, "Frontend Dev");
  assert.equal(matches.some((match) => match.name === "Security Reviewer"), false);

  for (const unsafe of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
    const bounded = runAsAgent("Orchestrator", () => routeAgents(state, "fix the React CSS component", unsafe));
    assert.equal(bounded[0].name, "Frontend Dev");
    assert.ok(bounded.length <= 5, `unsafe limit ${unsafe} must fall back to a bounded result`);
  }
});

test("routeAgents scores capability types and SDD phase groups", () => {
  const specialists = [
    runtime("Planning Specialist", { role: "lead", agentType: "planner", groupName: "Planning", consultWhen: "requirements and product scope", routingTags: ["proposal"], responsibilities: ["design specs"] }),
    runtime("Implementation Coder", { role: "lead", agentType: "coder", groupName: "Engineering", consultWhen: "backend component", domain: [{ path: "src/api", description: "service migration", read: true, upsert: true, delete: false }] }),
    runtime("QA Tester", { role: "lead", agentType: "tester", groupName: "QA Validation", consultWhen: "acceptance evidence" }),
    runtime("Security Reviewer", { role: "lead", agentType: "reviewer", groupName: "Validation", consultWhen: "auth permission review" }),
  ];
  const state = stateWith([
    runtime("Orchestrator", { role: "orchestrator", allowedAgents: specialists.map((entry) => entry.config.name) }),
    ...specialists,
  ]);

  const task = "plan product requirements proposal design specs tasks; implement backend API service migration component; test QA acceptance evidence; security auth permission review; apply-progress implementation; verify-report release confidence";
  const matches = runAsAgent("Orchestrator", () => routeAgents(state, task, 1000));
  assert.deepEqual(new Set(matches.map((match) => match.name)), new Set(specialists.map((entry) => entry.config.name)));
  assert.ok(matches.find((match) => match.name === "Planning Specialist")?.reasons.includes("planning-group"));
  assert.ok(matches.find((match) => match.name === "Implementation Coder")?.reasons.includes("coder-type"));
  assert.ok(matches.find((match) => match.name === "QA Tester")?.reasons.includes("tester-type"));
  assert.ok(matches.find((match) => match.name === "Security Reviewer")?.reasons.includes("reviewer-type"));

  state.mode = "plan";
  const planning = runAsAgent("Orchestrator", () => routeAgents(state, task));
  assert.equal(planning.some((match) => ["Implementation Coder", "QA Tester"].includes(match.name)), false);
});

test("buildOrchestratorPrompt routes to the ACTUAL configured leads, nothing hardcoded (H3/L4)", () => {
  // A team with entirely custom lead names — no "Engineering Lead"/"Planning
  // Lead" anywhere. The routing block must name these leads and their cues.
  const lead = (name: string, extra: Partial<AgentConfig> = {}): AgentConfig =>
    ({ name, path: `${name}.md`, role: "lead", routingTags: [], domain: [], ...extra });
  const shipwright = lead("Shipwright", { consultWhen: "building and shipping features", agentType: "lead" });
  const cartographer = lead("Cartographer", { consultWhen: "mapping requirements and specs", agentType: "lead" });
  const orchestrator = lead("Conductor", { role: "orchestrator" });

  const state = stateWith([
    { config: orchestrator, systemPrompt: "ORCH-SYS", status: "idle", task: "", lastWork: "", toolCount: 0, elapsedMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, contextPct: 0, runCount: 0, sessionFile: "" },
  ]);
  state.config = {
    orchestrator, agents: [shipwright, cartographer], sharedContext: [],
    settings: { subagentOutputLimit: 100, defaultTools: "read", maxParallel: 2, distiller: { enabled: false, model: "", conversationLines: 10 } },
  } as any;

  const prompt = buildOrchestratorPrompt(state, { cwd: "/repo" } as any);

  // Names the configured leads and their cues.
  assert.match(prompt, /Shipwright/);
  assert.match(prompt, /Cartographer/);
  assert.match(prompt, /building and shipping features/);
  assert.match(prompt, /mapping requirements and specs/);
  // Routing lines are derived from the real cues → real leads.
  assert.match(prompt, /Work matching "building and shipping features" → shipwright \(Shipwright\)\./);
  assert.match(prompt, /Work matching "mapping requirements and specs" → cartographer \(Cartographer\)\./);
  // Nothing hardcoded from the example teams leaks in.
  assert.doesNotMatch(prompt, /Engineering Lead|Planning Lead/);
});
