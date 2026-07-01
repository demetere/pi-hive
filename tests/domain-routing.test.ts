import assert from "node:assert/strict";
import { test } from "node:test";
import { bashMutationKind, domainAllows, enforceDomainForTool, pathWithin } from "../src/engine/domain.ts";
import { routeAgents } from "../src/engine/routing.ts";
import { runAsAgent } from "../src/engine/session.ts";
import type { AgentRuntime, HiveState } from "../src/core/types.ts";

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
    teamMode: "team",
    normalToolNames: [],
    streamStartMs: 0,
    streamedChars: 0,
    lastTokPerSec: 0,
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
  const ctx = { cwd: "/repo" } as any;
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
});
