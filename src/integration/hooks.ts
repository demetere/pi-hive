import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { AgentConfig, HiveState } from "../core/types";
import { agentSlug, boundedDiagnostics, clip, configuredChildAgents, extractUsage, safeJson, textFromMessage, textOfResult, truncateMiddle } from "../core/utils";
import { logRecord } from "../engine/state";
import { reloadTeam } from "../engine/session";
import { enforceDomainForTool } from "../engine/domain";
import { buildOrchestratorPrompt } from "../agents/prompts";
import { applyMode, captureNormalTools, installHeader, updateWidget } from "../ui/tui/widget";
import { clearHiveActivityWidget } from "../ui/tui/activity";
import { resolveHiveSddStatus } from "../engine/sdd";
import { ensureDashboard } from "../engine/dashboard";
import { resolveRuntime } from "../engine/agent-lookup";
import { emitHiveEvent, emitModelCatalog, writeHiveStateSnapshot } from "../engine/observability";
import { resolveConfiguredPath } from "../core/safe-path";
import { cancelWorkerQueue } from "../engine/governance";

const EXTENSION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function registerHooks(pi: ExtensionAPI, state: HiveState) {
  // toolCallId → startedAt for the orchestrator's own tool calls, so
  // orchestrator_tool_end can carry durationMs the same way workers do (J5).
  // Bounded by in-flight calls: entries are deleted on tool_result.
  const orchestratorToolStartedAt = new Map<string, number>();

  // Debounced snapshot write so orchestrator-only conversations (no delegations)
  // still reach hive-state.json (J5). Delegations trigger their own snapshot in
  // dispatch.ts; this covers turns where the orchestrator works alone.
  let orchestratorSnapshotTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleOrchestratorSnapshot = () => {
    if (orchestratorSnapshotTimer) return;
    orchestratorSnapshotTimer = setTimeout(() => {
      orchestratorSnapshotTimer = undefined;
      try { writeHiveStateSnapshot(state); } catch { /* best-effort */ }
    }, 2000);
    orchestratorSnapshotTimer.unref?.();
  };

  const setOrchestratorStatus = (status: "idle" | "running" | "done" | "error") => {
    const orch = state.orchestratorRuntime;
    if (!orch) return;
    orch.status = status;
    if (status === "running") {
      orch.startedAt = Date.now();
      orch.elapsedMs = 0;
      orch.runStartInputTokens = orch.inputTokens;
      orch.runStartOutputTokens = orch.outputTokens;
    } else if (orch.startedAt) {
      orch.elapsedMs = Date.now() - orch.startedAt;
      orch.startedAt = undefined;
    }
    try { writeHiveStateSnapshot(state); } catch { /* best-effort */ }
  };

  pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    // Enforcement (domain + agent-type policy) runs in plan AND hive mode; only
    // normal mode is unguarded plain Pi.
    if (state.mode === "normal") return;
    // Orchestrator tool telemetry parity (A5). This hook fires on the main
    // session's own tool calls; worker tool calls are emitted from dispatch.ts.
    const orch = state.orchestratorRuntime;
    if (orch) orch.toolCount++;
    if (event.toolCallId) orchestratorToolStartedAt.set(event.toolCallId, Date.now());
    const argsJson = safeJson(event.input);
    emitHiveEvent(state, "orchestrator_tool_start", {
      agent: "Orchestrator",
      toolName: event.toolName || "unknown",
      toolCallId: event.toolCallId,
      args: truncateMiddle(argsJson, 500),
      truncated: argsJson.length > 500,
    }, "Orchestrator");
    return enforceDomainForTool(state, event, ctx);
  });

  pi.on("tool_result", async (event) => {
    // Always release the start-time entry, even when we bail below — otherwise a
    // mode flip to normal between tool_call and tool_result strands the key
    // forever (M-misc leak).
    const startedAt = event.toolCallId ? orchestratorToolStartedAt.get(event.toolCallId) : undefined;
    if (event.toolCallId) orchestratorToolStartedAt.delete(event.toolCallId);
    if (state.mode === "normal") return;
    const resultText = textOfResult(event.content);
    emitHiveEvent(state, "orchestrator_tool_end", {
      agent: "Orchestrator",
      toolName: event.toolName || "unknown",
      toolCallId: event.toolCallId,
      isError: event.isError === true,
      resultPreview: truncateMiddle(resultText, 500),
      truncated: resultText.length > 500,
      durationMs: startedAt != null ? Date.now() - startedAt : undefined,
    }, "Orchestrator");
  });

  // J3: re-emit the model catalog when the main model changes mid-session, so
  // `inherit` workers aren't left described by a stale catalog. Gated off in
  // normal mode (the extension does nothing there). The DB upsert is idempotent.
  pi.on("model_select", async (event, ctx: ExtensionContext) => {
    if (state.mode === "normal") return;
    // The event carries the newly-selected model; pass it through so the catalog
    // covers what `inherit` workers now resolve to, even if it isn't config-
    // declared (M1). Fall back to ctx.model if the event shape lacks it.
    const contextModel = (ctx as ExtensionContext & { model?: { provider?: string; id?: string } }).model;
    const m = event.model || contextModel;
    const effectiveModel = m?.provider && m?.id ? `${m.provider}/${m.id}` : undefined;
    try { emitModelCatalog(state, state.modelRegistry ?? ctx.modelRegistry, effectiveModel); } catch { /* best-effort */ }
    // Phase 4.4: emit the SWITCH itself (not just the catalog re-emit) so the
    // main session's model changes are an observable event, with provenance.
    const prev = event?.previousModel;
    const previousModel = prev?.provider && prev?.id ? `${prev.provider}/${prev.id}` : undefined;
    emitHiveEvent(state, "model_select", {
      agent: "Orchestrator", model: effectiveModel, previousModel, source: event?.source,
    }, "Orchestrator");
  });

  // Phase 4.4: the main session's thinking-level changes, previously invisible.
  pi.on("thinking_level_select", async (event) => {
    if (state.mode === "normal") return;
    emitHiveEvent(state, "thinking_level_select", {
      agent: "Orchestrator", level: event?.level, previousLevel: event?.previousLevel,
    }, "Orchestrator");
  });

  // Phase 4.1: main-session compactions produced zero telemetry — the orchestrator
  // was a second-class citizen next to its own workers (which emit worker_compaction).
  pi.on("session_compact", async (event) => {
    if (state.mode === "normal") return;
    emitHiveEvent(state, "orchestrator_compaction", {
      agent: "Orchestrator",
      reason: event?.reason,
      willRetry: event?.willRetry === true,
      fromExtension: event?.fromExtension === true,
    }, "Orchestrator");
  });

  // Phase 4.10/4.11: per-turn latency. turn_start stamps the start; turn_end
  // emits one `turn` event carrying turnIndex + the measured duration — the only
  // per-turn timing the dashboard can surface for the main session.
  const turnStartedAt = new Map<number, number>();
  // W1.7: a turn that errors or is aborted never fires turn_end, so its start
  // stamp would live in the map forever. Cap the map by evicting the oldest
  // insertion (Map preserves insertion order) whenever it grows past the bound —
  // only the newest in-flight turns can still legitimately match a turn_end.
  const MAX_TRACKED_TURNS = 64;
  pi.on("turn_start", async (event) => {
    if (state.mode === "normal") return;
    setOrchestratorStatus("running");
    if (typeof event?.turnIndex !== "number") return;
    turnStartedAt.set(event.turnIndex, Date.now());
    while (turnStartedAt.size > MAX_TRACKED_TURNS) {
      const oldest = turnStartedAt.keys().next().value;
      if (oldest === undefined) break;
      turnStartedAt.delete(oldest);
    }
  });
  pi.on("turn_end", async (event) => {
    if (state.mode === "normal") return;
    setOrchestratorStatus("done");
    const started = typeof event?.turnIndex === "number" ? turnStartedAt.get(event.turnIndex) : undefined;
    if (typeof event?.turnIndex === "number") turnStartedAt.delete(event.turnIndex);
    emitHiveEvent(state, "turn", {
      agent: "Orchestrator",
      turnIndex: event?.turnIndex,
      durationMs: started != null ? Date.now() - started : undefined,
    }, "Orchestrator");
  });

  // Phase 4.10/4.11: the ONLY pre-retry view of provider back-pressure. Surface
  // rate-limit / overload responses (429/529) and their retry-after headers so a
  // stalled session has a visible cause. Only emit non-2xx to avoid one row per
  // successful call flooding the log.
  pi.on("after_provider_response", async (event) => {
    if (state.mode === "normal") return;
    const status = Number(event?.status);
    if (!Number.isFinite(status) || (status >= 200 && status < 300)) return;
    const headers = event?.headers || {};
    const pick = (k: string) => headers[k] ?? headers[k.toLowerCase()];
    emitHiveEvent(state, "provider_response", {
      agent: "Orchestrator",
      status,
      retryAfter: pick("retry-after"),
      rateLimitRemaining: pick("anthropic-ratelimit-requests-remaining") ?? pick("x-ratelimit-remaining"),
    }, "Orchestrator");
  });

  // Remaining SDK event classes (Phase 4, "everything the SDK exposes"). Each is
  // emitted with a bounded payload and rendered generically in the Activity feed
  // (the feed titles the common ones and dumps the payload for the rest). None
  // carries unbounded bodies.
  pi.on("user_bash", async (event) => {
    if (state.mode === "normal") return;
    emitHiveEvent(state, "user_bash", {
      agent: "Orchestrator",
      command: truncateMiddle(String(event?.command || ""), 500),
      excludeFromContext: event?.excludeFromContext === true,
    }, "Orchestrator");
  });
  // `input` telemetry is source-only (the footer already re-renders on input, a
  // separate concern): record where user input came from and how it will be
  // delivered, not the text (that lands as a user_message already).
  pi.on("input", async (event) => {
    if (state.mode === "normal") return;
    emitHiveEvent(state, "input", {
      agent: "User",
      source: event?.source,
      streamingBehavior: event?.streamingBehavior,
      hasImages: Array.isArray(event?.images) && event.images.length > 0,
    }, "User");
  });
  pi.on("session_before_fork", async (event) => {
    if (state.mode === "normal") return;
    emitHiveEvent(state, "session_fork", {
      agent: "Orchestrator",
      entryId: event?.entryId,
      position: event?.position,
    }, "Orchestrator");
  });
  pi.on("session_tree", async (event) => {
    if (state.mode === "normal") return;
    emitHiveEvent(state, "session_tree", {
      agent: "Orchestrator",
      newLeafId: event?.newLeafId ?? undefined,
      oldLeafId: event?.oldLeafId ?? undefined,
      fromExtension: event?.fromExtension === true,
    }, "Orchestrator");
  });
  pi.on("session_info_changed", async (event) => {
    if (state.mode === "normal") return;
    emitHiveEvent(state, "session_info_changed", {
      agent: "Orchestrator",
      name: event?.name ? truncateMiddle(String(event.name), 200) : undefined,
    }, "Orchestrator");
  });

  pi.on("before_agent_start", async (event, _ctx: ExtensionContext) => {
    if (!state.config || state.mode === "normal") return;
    const planMode = state.mode === "plan";
    const catalog = state.config.agents.map((root) => {
      const lines: string[] = [];
      const renderCatalogAgent = (agent: AgentConfig, depth: number) => {
        const runtime = resolveRuntime(state, agent.slug || agent.name);
        const agentConfig = runtime?.config || agent;
        const tags = agentConfig.routingTags?.length ? ` [${agentConfig.routingTags.join(", ")}]` : "";
        const indent = "  ".repeat(depth);
        lines.push(`${indent}- ${agentSlug(agentConfig)} — ${agentConfig.name}${tags}: ${agentConfig.consultWhen || "team work"}`);
        for (const child of configuredChildAgents(agent)) renderCatalogAgent(child, depth + 1);
      };
      configuredChildAgents(root).forEach((child) => renderCatalogAgent(child, 1));
      return `## ${root.name}\n- ${agentSlug(root)} — ${root.name}${root.routingTags?.length ? ` [${root.routingTags.join(", ")}]` : ""}: ${root.consultWhen || "team work"}\n${lines.join("\n")}`;
    }).join("\n\n");

    const planBlock = planMode
      ? `# Plan mode — you are the main session of the PLANNING team
You are running as the visible main session in PLAN mode. Your job is to produce a COMPLETE OpenSpec change for the requested work, not to implement it. You have NO file-writing tools in this mode — you delegate. Drive the planning team to author the change under \`openspec/changes/<change-id>/\` in dependency order: proposal → design/specs → tasks, using the /opsx-* commands OpenSpec installs. Spec deltas must follow OpenSpec's path convention: \`specs/<capability>/spec.md\` inside the change (use the capability name, not the change-id again; do not create a bare \`spec.md\` or \`specs/spec.md\`). Use plan_new to scaffold/select a change and delegate to planners (and reviewers, for plan-phase feedback) for each artifact. When scope or requirements are ambiguous, use ask_user to interrogate the human BEFORE writing artifacts — do not guess. Each finished artifact is reviewed in the dashboard's plan-review UI; approving the tasks artifact opens the execution gate. Do NOT write or modify any files yourself in this mode — that is execution, which happens in hive mode. The end result of plan mode is an approved, validated tasks.md; then the user switches to hive mode (or runs /hive-execute) to build it.

`
      : "";

    return {
      systemPrompt: `${event.systemPrompt}

# ${planMode ? "Hive plan mode" : "Hive orchestrator mode"}
${planBlock}${buildOrchestratorPrompt(state, _ctx)}

Use route_agent when the best specialist is not obvious, delegate to specialists with delegate_agent, then synthesize their findings.
When calling delegate_agent, ALWAYS provide both required arguments: {"agent":"<exact name from the roster below>","task":"<focused task, paths, and expected output>"}. Never call delegate_agent with {} or omit task/agent.
Use team_status to inspect live team state and team_conversation(agent: "<name>") to read one specific agent's own transcript. When stable lessons should be preserved, ask the relevant specialist to update its own mental model.
Keep delegations focused and include enough context for the worker to act independently.

Available ${planMode ? "planners" : "agents"}:
${catalog}`,
    };
  });

  pi.on("message_end", async (event, ctx: ExtensionContext) => {
    if (event.message.role === "assistant") {
      // Phase 4.3: capture the MAIN session's live context-window fill, mirroring
      // the per-worker poll in dispatch.ts. tokens is null right after compaction
      // until the next response, so keep the last known percent rather than
      // flashing to 0.
      try {
        const usage = ctx.getContextUsage();
        if (usage && state.orchestratorRuntime) {
          if (usage.percent != null) state.orchestratorRuntime.contextPct = usage.percent;
          if (usage.tokens != null) state.orchestratorRuntime.tokens = usage.tokens;
          if (usage.contextWindow != null) state.orchestratorRuntime.contextWindow = usage.contextWindow;
        }
      } catch { /* capability probe is best-effort */ }
    }
    // This hook is registered once, on the orchestrator's own pi: ExtensionAPI
    // — workers run as separate in-process AgentSessions (see dispatchAgent)
    // that never load pi-hive's extension hooks, so this handler structurally
    // never fires for worker output. It only ever sees the orchestrator's own
    // messages. Each worker keeps its own full transcript in agents/<slug>.jsonl
    // (read it via team_conversation(agent)) — unbounded worker output (a
    // mental-model YAML can be hundreds of KB) never reaches the shared log.
    if (state.mode === "normal") return;
    const message = event.message;
    const role = message?.role;
    if (!role || role === "toolResult") return;
    // Accumulate the orchestrator's own usage/cost so the main session gets the
    // same token/cost observability workers have (A5).
    if (role === "assistant" && message?.usage && state.orchestratorRuntime) {
      const u = extractUsage(message.usage);
      const orch = state.orchestratorRuntime;
      orch.inputTokens += u.input;
      orch.outputTokens += u.output;
      if (orch.startedAt) orch.elapsedMs = Date.now() - orch.startedAt;
      orch.cacheReadTokens += u.cacheRead;
      orch.cacheWriteTokens += u.cacheWrite;
      orch.reasoningTokens += u.reasoning;
      orch.costUsd += u.cost;
      // J5: persist a snapshot so a delegation-free conversation's orchestrator
      // usage still lands in hive-state.json. Debounced to avoid a write per
      // message during a burst.
      scheduleOrchestratorSnapshot();
    }
    // Phase 4.2: an orchestrator turn that errors or hits a length stop must be
    // visible. Emit a compact orchestrator_message event carrying the SDK's
    // stop_reason / error / model / per-message usage — previously reduced to
    // just {text, truncated} on assistant_message. Only for assistant turns
    // (user turns have no usage/stop_reason).
    if (role === "assistant" && (message?.stopReason || message?.errorMessage || message?.usage)) {
      const u = message?.usage ? extractUsage(message.usage) : undefined;
      emitHiveEvent(state, "orchestrator_message", {
        agent: "Orchestrator",
        stopReason: message?.stopReason ? String(message.stopReason) : undefined,
        errorMessage: message?.errorMessage ? truncateMiddle(String(message.errorMessage), 500) : undefined,
        // W1.6: keep BOTH the requested model and the ground-truth served model.
        // Collapsing them (`model || responseModel`) hid provider fallbacks/routing
        // where the served model differs from the one asked for. `model` stays the
        // requested field for back-compat; `responseModel` is the authoritative
        // served model.
        model: message?.model || message?.responseModel,
        responseModel: message?.responseModel ? String(message.responseModel) : undefined,
        // Item 9 / R3-1.4: the per-message identity the SDK's AssistantMessage
        // exposes — provider, api, responseId, and bounded diagnostics — all on this
        // same message object. (Round 2 captured none of these behind a comment that
        // wrongly claimed they didn't exist.)
        provider: message?.provider ? String(message.provider) : undefined,
        api: message?.api ? String(message.api) : undefined,
        responseId: message?.responseId ? String(message.responseId) : undefined,
        diagnostics: boundedDiagnostics(message?.diagnostics),
        usage: u ? { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, reasoning: u.reasoning, cost: u.cost } : undefined,
      }, "Orchestrator");
    }
    const text = textFromMessage(message).trim();
    if (!text) return;
    const from = role === "user" ? "User" : role === "assistant" ? "Orchestrator" : role;
    logRecord(state, { from, type: role, message: text });
    const clipped = clip(text, 8000);
    emitHiveEvent(state, role === "user" ? "user_message" : "assistant_message", { text: clipped.text, truncated: clipped.truncated }, from);
  });

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    state.shuttingDown = false;
    const lifecycleGeneration = state.lifecycleGeneration = (state.lifecycleGeneration || 0) + 1;
    state.widgetCtx = ctx;
    // Capture the ModelRegistry from the full session_start ctx — the reliable
    // handle. The mode-switch ctx that used to feed emitModelCatalog could lack
    // it, leaving model_versions empty and the topology dial without pillars.
    state.modelRegistry = ctx.modelRegistry;
    state.onRuntimeUpdate = () => updateWidget(state);
    state.onRuntimeFinish = (runtime, finishCtx) => {
      if (finishCtx.hasUI) finishCtx.ui.notify(`${runtime.config.name} ${runtime.status} in ${Math.round(runtime.elapsedMs / 1000)}s`, runtime.status === "done" ? "info" : "error");
    };
    try {
      reloadTeam(state, ctx);
      state.sddStatus = resolveHiveSddStatus(state, ctx.cwd);
      logRecord(state, { from: "System", type: "system", message: "Session started" });
      captureNormalTools(state);
      applyMode(state, ctx, "normal", { notify: false });
      // Ensure the shared, global telemetry dashboard daemon is running. This
      // hook only fires for hive-opted-in projects (the extension registers
      // nothing otherwise), so the opt-in gate is satisfied. Fire-and-forget and
      // Bun-gated: the first hive session with Bun starts the daemon, later
      // sessions adopt the running one. No browser tab opens automatically — the
      // header shows the URL. It is NOT torn down on session shutdown (shared).
      const telemetry = state.config?.settings?.telemetry;
      const dashboardStartup = telemetry?.enabled !== false && telemetry?.dashboardAutoStart !== false
        ? ensureDashboard(state, ctx, EXTENSION_ROOT, { open: false })
        : Promise.resolve({ running: false, url: "", adopted: false, spawned: false });
      void dashboardStartup.then((result) => {
        // The async health-check/spawn may finish after session_shutdown. Ignore
        // that stale completion instead of reinstalling UI on a dead session.
        if (state.shuttingDown || state.lifecycleGeneration !== lifecycleGeneration) {
          state.obsServer = undefined;
          return;
        }
        if (result.running && ctx.mode === "tui") installHeader(state, ctx);
      }).catch(() => { /* best-effort; the dashboard is optional */ });
      const missingSkills = Array.from(state.runtimes.values()).flatMap((runtime) =>
        (runtime.config.skills || [])
          .filter((ref) => !resolveConfiguredPath(ctx.cwd, ref.path, ref.allowOutsideProject === true))
          .map((ref) => `${runtime.config.name}: ${ref.path}`),
      );
      const missing = missingSkills.length ? `\nMissing configured skills: ${missingSkills.slice(0, 5).join(", ")}${missingSkills.length > 5 ? "..." : ""}` : "";
      if (ctx.hasUI) ctx.ui.notify(`Hive loaded: ${state.runtimes.size} agents in normal mode\nUse /hive-toggle or Ctrl+Alt+T to switch to orchestrator mode.${missing}`, missingSkills.length ? "warning" : "info");
    } catch (error: unknown) {
      // H5: on a config-load failure, force the session back to plain-Pi normal
      // mode so it is never left with hive tools registered but unconfigured.
      // Best-effort — capture whatever the current tool set is and restore it.
      try {
        state.mode = "normal";
        captureNormalTools(state);
        applyMode(state, ctx, "normal", { notify: false });
      } catch { /* nothing more we can do; the notify below tells the user */ }
      const message = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI) ctx.ui.notify(`Hive failed to load: ${message}`, "error");
    }
  });

  pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
    state.shuttingDown = true;
    state.lifecycleGeneration = (state.lifecycleGeneration || 0) + 1;
    if (orchestratorSnapshotTimer) clearTimeout(orchestratorSnapshotTimer);
    orchestratorSnapshotTimer = undefined;
    orchestratorToolStartedAt.clear();
    turnStartedAt.clear();
    cancelWorkerQueue(state);
    for (const runtime of state.runtimes.values()) {
      if (runtime.timer) clearInterval(runtime.timer);
      runtime.timer = undefined;
      if (runtime.session) {
        try { void Promise.resolve(runtime.session.abort?.()).catch((): void => undefined); } catch { /* noop */ }
        try { runtime.session.dispose(); } catch { /* noop */ }
        runtime.session = undefined;
      }
    }
    // Distillers are tracked separately from worker runtimes. Abort their
    // in-memory sessions and give their promises a bounded chance to settle;
    // their write guard also refuses any completion after shuttingDown is set.
    for (const session of state.backgroundDistillerSessions || []) {
      try { void Promise.resolve(session.abort?.()).catch((): void => undefined); } catch { /* noop */ }
      try { session.dispose?.(); } catch { /* noop */ }
    }
    const background = [...(state.backgroundTasks || [])];
    if (background.length) {
      await Promise.race([
        Promise.allSettled(background),
        new Promise<void>((resolve) => setTimeout(resolve, 1000)),
      ]);
    }
    state.backgroundDistillerSessions?.clear();
    state.backgroundTasks?.clear();
    state.distillQueues?.clear();
    // The telemetry dashboard is a SHARED global daemon — other sessions may be
    // using it — so we do NOT kill it here. Just drop this session's reference.
    // Explicit teardown is /hive-observe-stop; the server also self-terminates
    // after its bounded idle timeout when no browser event stream remains.
    state.obsServer = undefined;
    if (state.dashboardActionTimer) clearInterval(state.dashboardActionTimer);
    state.dashboardActionTimer = undefined;
    state.dashboardActionOffset = undefined;
    state.onRuntimeUpdate = undefined;
    state.onRuntimeFinish = undefined;
    if (ctx.mode === "tui") {
      ctx.ui.setHeader(undefined);
      ctx.ui.setWidget("hive-tree", undefined);
      clearHiveActivityWidget(state);
    }
    if (ctx.hasUI) {
      ctx.ui.setStatus("hive", undefined);
      if (ctx.mode === "tui") ctx.ui.setWorkingVisible(true);
    }
  });
}
