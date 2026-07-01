import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { HIVE_SESSIONS_DIR } from "../core/constants";
import type { AgentConfig, AgentRuntime, HiveConfig, HiveState, SessionState } from "../core/types";
import { parseFrontmatter } from "../core/yaml";
import {
  ensureDir,
  normalizeDomainScopes,
  normalizeKnowledgeRefs,
  normalizeStringList,
  normalizeTools,
  safeRead,
  slug,
} from "../core/utils";
import { allConfiguredAgents, loadConfig } from "../core/config";

export function restoreOrCreateSession(state: HiveState, ctx: ExtensionContext, _cfg: HiveConfig): SessionState {
  const existing = ctx.sessionManager
    .getEntries()
    .filter((entry: any) => entry.type === "custom" && entry.customType === "hive-session")
    .pop() as { data?: SessionState } | undefined;

  if (existing?.data?.sessionId && existing.data.sessionDir && existing.data.conversationLog) {
    return {
      ...existing.data,
      observabilityLog: existing.data.observabilityLog || join(existing.data.sessionDir, "hive-events.jsonl"),
    };
  }

  const sessionId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionRoot = resolve(ctx.cwd, HIVE_SESSIONS_DIR);
  const sessionDir = join(sessionRoot, sessionId);
  const created: SessionState = {
    sessionId,
    sessionDir,
    conversationLog: join(sessionDir, "conversation.jsonl"),
    observabilityLog: join(sessionDir, "hive-events.jsonl"),
    activeTeam: "all",
  };
  state.pi.appendEntry("hive-session", created);
  return created;
}

export function loadAgentRuntime(state: HiveState, ctx: ExtensionContext, cfg: HiveConfig, agent: AgentConfig): AgentRuntime {
  const fullPath = resolve(ctx.cwd, agent.path);
  const parsed = parseFrontmatter(safeRead(fullPath));
  const attrs = parsed.attrs || {};
  const agentSlug = slug(agent.name || attrs.name || fullPath);
  const sessionFile = join(state.session!.sessionDir, "agents", `${agentSlug}.jsonl`);
  const tools = normalizeTools(String(attrs.tools || agent.tools || cfg.settings.defaultTools), cfg.settings.defaultTools);
  // model and thinking are required per-agent (no global default): every agent
  // declares them explicitly in its frontmatter.
  const model = String(attrs.model || agent.model || "").trim();
  const thinking = String(attrs.thinking || agent.thinking || "").trim();
  if (!model) throw new Error(`Agent "${agent.name || agentSlug}" is missing required 'model' in frontmatter (${agent.path}).`);
  if (!thinking) throw new Error(`Agent "${agent.name || agentSlug}" is missing required 'thinking' in frontmatter (${agent.path}).`);

  // Mental model is loaded by convention: the sibling <stem>-mental-model.yaml
  // next to the agent's .md. It is always-on and updatable (the distiller
  // targets it). No need to declare it in frontmatter.
  const explicitContext = normalizeKnowledgeRefs(attrs.context || (agent as any).context);
  const mentalModelPath = agent.path.replace(/\.md$/, "-mental-model.yaml");
  const hasMentalModel = existsSync(resolve(ctx.cwd, mentalModelPath));
  const alreadyListed = explicitContext.some((ref) => resolve(ctx.cwd, ref.path) === resolve(ctx.cwd, mentalModelPath));
  const context = hasMentalModel && !alreadyListed
    ? [{ path: mentalModelPath, useWhen: "Your durable mental model for this role.", updatable: true }, ...explicitContext]
    : explicitContext;
  const mergedConfig: AgentConfig = {
    ...agent,
    name: String(attrs.name || agent.name || agentSlug),
    model,
    tools,
    thinking,
    color: String(attrs.color || agent.color || ""),
    consultWhen: String(attrs.consultWhen || attrs.description || agent.consultWhen || ""),
    routingTags: normalizeStringList(attrs.routingTags || (agent as any).routingTags),
    responsibilities: normalizeStringList(attrs.responsibilities || (agent as any).responsibilities),
    // Delegation permissions are derived from the team hierarchy, not from
    // per-agent prompt files: orchestrator -> leads -> members.
    allowedAgents: agent.allowedAgents,
    context,
    skills: normalizeKnowledgeRefs(attrs.skills || (agent as any).skills),
    domain: normalizeDomainScopes(attrs.domain || (agent as any).domain, `${agent.name || agentSlug}.domain`),
  };

  return {
    config: mergedConfig,
    systemPrompt: parsed.body || `You are ${mergedConfig.name}. Return concise, evidence-backed findings.`,
    status: "idle",
    task: "",
    lastWork: mergedConfig.consultWhen || "Ready",
    toolCount: 0,
    elapsedMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    contextPct: 0,
    runCount: 0,
    sessionFile,
  };
}

export function reloadTeam(state: HiveState, ctx: ExtensionContext) {
  state.config = loadConfig(ctx.cwd);
  state.session = restoreOrCreateSession(state, ctx, state.config);
  ensureDir(state.session.sessionDir);
  ensureDir(join(state.session.sessionDir, "agents"));

  state.runtimes = new Map();
  for (const agent of allConfiguredAgents(state.config)) {
    const runtime = loadAgentRuntime(state, ctx, state.config, agent);
    state.runtimes.set(runtime.config.name.toLowerCase(), runtime);
  }

  // A reload reuses the same session and its on-disk event log, but the runtime
  // counters above start at 0. Seed them from the persisted log so usage totals
  // (tokens, cost, run/tool counts) continue from where they were rather than
  // resetting on every reload. Only the live in-memory tally was ever lost; the
  // history is fully recoverable from delegation_end events.
  restoreRuntimeCounters(state);
}

// Rebuild per-agent cumulative counters from the session's hive-events.jsonl.
// Each delegation_end carries the agent's cumulative runtime snapshot at that
// moment; the peak per agent is its true accumulated total before the reload.
function restoreRuntimeCounters(state: HiveState) {
  const logPath = state.session?.observabilityLog;
  if (!logPath || !existsSync(logPath)) return;
  let text: string;
  try { text = readFileSync(logPath, "utf8"); } catch { return; }

  // peak cumulative values keyed by agent name
  const peak = new Map<string, { input: number; output: number; cost: number; runs: number; tools: number }>();
  for (const line of text.split("\n")) {
    if (!line.trim() || !line.includes("delegation_end")) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type !== "delegation_end") continue;
    const rt = ev.payload?.runtime;
    const name = rt?.name || ev.payload?.from;
    if (!name || !rt) continue;
    const cur = peak.get(name) || { input: 0, output: 0, cost: 0, runs: 0, tools: 0 };
    cur.input = Math.max(cur.input, Number(rt.inputTokens || 0));
    cur.output = Math.max(cur.output, Number(rt.outputTokens || 0));
    cur.cost = Math.max(cur.cost, Number(rt.costUsd || 0));
    cur.runs = Math.max(cur.runs, Number(rt.runCount || 0));
    cur.tools = Math.max(cur.tools, Number(rt.toolCount || 0));
    peak.set(name, cur);
  }

  for (const runtime of state.runtimes.values()) {
    const p = peak.get(runtime.config.name);
    if (!p) continue;
    runtime.inputTokens = p.input;
    runtime.outputTokens = p.output;
    runtime.costUsd = p.cost;
    runtime.runCount = p.runs;
    runtime.toolCount = p.tools;
  }
}

// Every subagent now runs in-process; concurrent workers can be mid-flight
// simultaneously (state.config.settings.maxParallel), so "which agent is
// calling right now" can no longer be read from process.env (that only ever
// worked because each worker used to be its own OS process with its own
// environment). AsyncLocalStorage scopes the current agent's name correctly
// per concurrent async call chain — the direct in-process replacement for the
// isolation that made the old env-var read safe by accident.
const currentAgentStorage = new AsyncLocalStorage<string>();

export function currentAgentName(): string {
  return currentAgentStorage.getStore() || "Orchestrator";
}

export function runAsAgent<T>(agentName: string, fn: () => T): T {
  return currentAgentStorage.run(agentName, fn);
}
