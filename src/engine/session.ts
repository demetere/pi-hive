import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { HIVE_SESSIONS_DIR } from "../core/constants";
import type { AgentConfig, AgentRuntime, HiveConfig, HiveMode, HiveState, SessionState } from "../core/types";
import { parseFrontmatter } from "../core/yaml";
import {
  ensureDir,
  forEachJsonlLine,
  normalizeAgentType,
  normalizeCommit,
  normalizeDomainScopes,
  normalizeKnowledgeRefs,
  normalizePlanStages,
  normalizeStringList,
  normalizeTools,
  safeRead,
  slug,
} from "../core/utils";
import { allConfiguredAgents, loadConfig, teamForMode } from "../core/config";
import { canonicalMode } from "../core/types";
import { runtimeKey } from "./agent-lookup";
import { resolveConfiguredPath } from "../core/safe-path";

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
  };
  state.pi.appendEntry("hive-session", created);
  return created;
}

export function loadAgentRuntime(state: HiveState, ctx: ExtensionContext, cfg: HiveConfig, agent: AgentConfig): AgentRuntime {
  const safePromptPath = resolveConfiguredPath(ctx.cwd, agent.path, agent.allowOutsideProject === true);
  if (!safePromptPath) throw new Error(`Agent prompt is missing or escapes the project root: ${agent.path}`);
  const fullPath = safePromptPath.canonicalPath;
  const parsed = parseFrontmatter(safeRead(fullPath));
  const attrs = parsed.attrs || {};
  const agentSlug = slug(String(attrs.slug || agent.slug || agent.name || attrs.name || fullPath));
  const sessionFile = join(state.session!.sessionDir, "agents", `${agentSlug}.jsonl`);
  const tools = normalizeTools(String(attrs.tools || agent.tools || cfg.settings.defaultTools), cfg.settings.defaultTools);
  // model and thinking are required for WORKER agents (they create their own
  // AgentSession with an explicit model). For the MAIN node they are optional
  // and display-only (H2/Decision 8): the visible session runs Pi's
  // user-selected model, so a main-node model/thinking is prompt/telemetry
  // decoration, never applied. Default to placeholders when absent.
  const isMainNode = agent.role === "orchestrator";
  const model = String(attrs.model || agent.model || "").trim() || (isMainNode ? "inherit" : "");
  const thinking = String(attrs.thinking || agent.thinking || "").trim() || (isMainNode ? "medium" : "");
  if (!isMainNode && !model) throw new Error(`Agent "${agent.name || agentSlug}" is missing required 'model' in frontmatter (${agent.path}).`);
  if (!isMainNode && !thinking) throw new Error(`Agent "${agent.name || agentSlug}" is missing required 'thinking' in frontmatter (${agent.path}).`);

  // Mental model is loaded by convention: the sibling <stem>-mental-model.yaml
  // next to the agent's .md. It is always-on and updatable (the distiller
  // targets it). No need to declare it in frontmatter.
  const explicitContext = normalizeKnowledgeRefs(attrs.context || (agent as any).context);
  const mentalModelPath = agent.path.replace(/\.md$/, "-mental-model.yaml");
  const safeMentalModel = resolveConfiguredPath(ctx.cwd, mentalModelPath, agent.allowOutsideProject === true);
  const alreadyListed = safeMentalModel
    ? explicitContext.some((ref) => resolveConfiguredPath(ctx.cwd, ref.path, ref.allowOutsideProject === true)?.canonicalPath === safeMentalModel.canonicalPath)
    : false;
  const context = safeMentalModel && !alreadyListed
    ? [{ path: mentalModelPath, useWhen: "Your durable mental model for this role.", updatable: true, allowOutsideProject: agent.allowOutsideProject === true }, ...explicitContext]
    : explicitContext;
  const mergedConfig: AgentConfig = {
    ...agent,
    slug: agentSlug,
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
    // Capability type + planner scoping + commit guidance. Frontmatter wins over
    // the config node, matching model/thinking/tools above. Validation already
    // ran in loadConfig, so these are well-formed here.
    agentType: normalizeAgentType(attrs.agentType || (agent as any).agentType) as AgentConfig["agentType"],
    stages: normalizePlanStages(attrs.stages || (agent as any).stages) as AgentConfig["stages"],
    commit: normalizeCommit(attrs.commit || (agent as any).commit),
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
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    contextPct: 0,
    runCount: 0,
    sessionFile,
  };
}

// Point the active config (orchestrator/agents) at the team for `mode` and
// rebuild state.runtimes for that team only. Returns silently if no config.
// Used by reloadTeam and on every mode switch so "who I can delegate to now"
// always reflects the active mode's team (plan → planning team, hive → hive team).
export function activateTeamRuntimes(state: HiveState, ctx: ExtensionContext, mode: HiveMode) {
  if (!state.config) return;
  const team = teamForMode(state.config, mode);
  state.config.orchestrator = team.main;
  state.config.agents = team.agents;

  // Rebuilding the map drops the previous team's runtimes; stop any live timers
  // and dispose any open worker sessions first so a mode switch mid-run does not
  // leak an interval or an AgentSession.
  for (const runtime of state.runtimes.values()) {
    if (runtime.timer) { clearInterval(runtime.timer); runtime.timer = undefined; }
    if (runtime.session) { try { runtime.session.dispose(); } catch { /* noop */ } runtime.session = undefined; }
  }
  state.runtimes = new Map();
  for (const agent of allConfiguredAgents(team)) {
    const runtime = loadAgentRuntime(state, ctx, state.config, agent);
    state.runtimes.set(runtimeKey(runtime), runtime);
  }
  restoreRuntimeCounters(state);
}

export function reloadTeam(state: HiveState, ctx: ExtensionContext) {
  state.config = loadConfig(ctx.cwd);
  state.session = restoreOrCreateSession(state, ctx, state.config);
  ensureDir(state.session.sessionDir);
  ensureDir(join(state.session.sessionDir, "agents"));

  // Build runtimes for the team active in the current mode (plan → planning
  // team, otherwise the hive team). activateTeamRuntimes also reseeds usage
  // counters from the persisted log so totals continue across a reload rather
  // than resetting. Normal mode loads the hive team so the tree/status is ready
  // the moment the user switches into plan/hive.
  activateTeamRuntimes(state, ctx, canonicalMode(state.mode) === "plan" ? "plan" : "hive");
}

// Rebuild per-agent cumulative counters from the session's hive-events.jsonl.
// Each delegation_end carries the agent's runtime snapshot at that moment.
//
// R3-1.1: restore from the agent's LATEST delegation_end row, not the peak across
// all rows. The runtime snapshot holds session-LIFETIME aggregates (overwritten
// from getSessionStats at run end), so a normal re-run's rows only grow and last ==
// max. But a `fresh` re-run ARCHIVES the prior transcript and resets the counters
// (dispatch.ts), so its post-reset row is deliberately SMALLER than the pre-fresh
// rows. A peak/`Math.max` would resurrect the pre-fresh totals as the restored
// baseline — reintroducing exactly the fresh-delta under-count W1.1 fixed (the next
// run's run-start baseline would be the stale 500 instead of the fresh 80, clamping
// its delta to ~0). The last row is the current post-reset reality for both paths.
// runCount is the one field that must never regress across a fresh reset (the run
// counter is monotonic and not reset), so keep its max explicitly.
export function restoreRuntimeCounters(state: HiveState) {
  const logPath = state.session?.observabilityLog;
  if (!logPath || !existsSync(logPath)) return;
  // latest runtime snapshot keyed by agent name (file order is chronological, so a
  // later row overwrites an earlier one), plus the monotonic max runCount. Scan
  // through a fixed-size JSONL buffer instead of materializing the whole log.
  const latest = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; cost: number; runs: number; tools: number }>();
  forEachJsonlLine(logPath, (line) => {
    if (!line.includes("delegation_end")) return;
    let ev: any;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.type !== "delegation_end") return;
    const rt = ev.payload?.runtime;
    const name = rt?.slug || rt?.name || ev.payload?.from;
    if (!name || !rt) return;
    const key = slug(String(name));
    const priorRuns = latest.get(key)?.runs ?? 0;
    latest.set(key, {
      input: Number(rt.inputTokens || 0),
      output: Number(rt.outputTokens || 0),
      cacheRead: Number(rt.cacheReadTokens || 0),
      cacheWrite: Number(rt.cacheWriteTokens || 0),
      // R4.3: restore reasoning too, else lifetime reasoning drops to 0 after a
      // mode switch / reloadTeam (the runtime summary carries it; it was just never
      // read back). Per-run deltas were unaffected; this fixes the live total.
      reasoning: Number(rt.reasoningTokens || 0),
      cost: Number(rt.costUsd || 0),
      // Monotonic: never let a later row lower the run count.
      runs: Math.max(priorRuns, Number(rt.runCount || 0)),
      tools: Number(rt.toolCount || 0),
    });
  });

  for (const runtime of state.runtimes.values()) {
    const p = latest.get(runtime.config.slug || slug(runtime.config.name));
    if (!p) continue;
    runtime.inputTokens = p.input;
    runtime.outputTokens = p.output;
    runtime.cacheReadTokens = p.cacheRead;
    runtime.cacheWriteTokens = p.cacheWrite;
    runtime.reasoningTokens = p.reasoning;
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

// The active change-id (a planning/execution change under openspec/changes/<id>/)
// flows the same way as the current agent name — through AsyncLocalStorage, not
// an env var — so it is correctly scoped per concurrent async call chain. Absent
// ⇒ "no active change"; verdict/approval/comment writes degrade gracefully
// (recorded against the session only) rather than throwing.
const currentChangeStorage = new AsyncLocalStorage<string | undefined>();

export function currentChangeId(): string | undefined {
  return currentChangeStorage.getStore();
}

export function runWithChange<T>(changeId: string | undefined, fn: () => T): T {
  return currentChangeStorage.run(changeId, fn);
}
