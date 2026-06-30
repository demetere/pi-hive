import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawnManaged } from "./process";
import { copyFileSync, existsSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { HIVE_AGENTS_DIR } from "../core/constants";
import { normalizeMentalModelSpine } from "../core/mental-model";
import type { AgentRuntime, HiveState } from "../core/types";
import {
  ensureDir,
  modelFrom,
  normalizeWorkerTools,
  safeRead,
  slug,
  tailLines,
  textFromMessage,
  truncateMiddle,
  extractUsage,
} from "../core/utils";
import { logRecord } from "./state";
import { currentAgentName } from "./session";
import { canDelegateTo } from "./domain";
import { agentMentalModelTarget, buildDistillerPrompt, buildWorkerPrompt, extractTagged } from "./prompts";
import { emitHiveEvent, runtimeSummary, writeHiveStateSnapshot } from "./observability";

function publishRuntimeUpdate(state: HiveState) {
  state.onRuntimeUpdate?.(state);
}

// Move an agent's current session log aside to a numbered archive so a fresh run
// can start clean without losing the prior run's transcript. "<slug>.jsonl"
// becomes "<slug>.run-<N>.jsonl" with N the next free index. Returns silently if
// there is nothing to archive.
function archivePriorRun(sessionFile: string) {
  const dir = dirname(sessionFile);
  const base = basename(sessionFile, ".jsonl"); // e.g. "core-tester"
  let existing: string[] = [];
  try { existing = readdirSync(dir); } catch { /* dir may not exist */ }
  const re = new RegExp(`^${base}\\.run-(\\d+)\\.jsonl$`);
  let max = 0;
  for (const f of existing) { const m = f.match(re); if (m) max = Math.max(max, Number(m[1])); }
  const archive = join(dir, `${base}.run-${max + 1}.jsonl`);
  renameSync(sessionFile, archive);
}

export async function dispatchAgent(state: HiveState, agentName: string, task: string, ctx: ExtensionContext, fresh = false): Promise<{ output: string; exitCode: number; elapsed: number }> {
  if (!state.config || !state.session) throw new Error("hive is not initialized");
  const caller = currentAgentName();
  const runtime = state.runtimes.get(agentName.toLowerCase());
  if (!runtime) {
    const available = Array.from(state.runtimes.values()).map((agent) => agent.config.name).join(", ");
    return { output: `Unknown agent "${agentName}". Available: ${available}`, exitCode: 1, elapsed: 0 };
  }
  const permission = canDelegateTo(state, caller, runtime.config.name);
  if (!permission.ok) {
    return { output: `Delegation blocked: ${permission.reason}`, exitCode: 1, elapsed: 0 };
  }
  if (runtime.status === "running") {
    return { output: `${runtime.config.name} is already running.`, exitCode: 1, elapsed: runtime.elapsedMs };
  }
  if (state.activeRuns >= state.config.settings.maxParallel) {
    return { output: `Max parallel agent runs reached (${state.config.settings.maxParallel}). Wait for a worker to finish.`, exitCode: 1, elapsed: 0 };
  }

  const prompt = buildWorkerPrompt(state, ctx, runtime, task);
  const model = modelFrom(ctx, runtime.config.model);
  const tools = normalizeWorkerTools(runtime.config.tools, state.config.settings.defaultTools);
  const thinking = runtime.config.thinking!;
  // fresh=true starts this agent's conversation clean. Rather than DELETE the
  // prior session (which would lose the transcript of earlier runs while their
  // token/cost still count), ARCHIVE it to a numbered run file so the dashboard
  // can show every run. The live sessionFile always holds the current run.
  if (fresh && existsSync(runtime.sessionFile)) {
    try { archivePriorRun(runtime.sessionFile); } catch { /* noop */ }
  }
  const hasExistingSession = existsSync(runtime.sessionFile);

  runtime.status = "running";
  runtime.task = task;
  runtime.lastWork = task;
  runtime.toolCount = 0;
  runtime.elapsedMs = 0;
  runtime.runCount++;
  runtime.startedAt = Date.now();
  state.activeRuns++;
  logRecord(state, { from: caller, to: runtime.config.name, type: "delegation", message: task });
  emitHiveEvent(state, "delegation_start", {
    from: caller,
    to: runtime.config.name,
    task,
    fresh,
    model,
    tools,
    thinking,
    runtime: runtimeSummary(runtime),
  }, caller);
  publishRuntimeUpdate(state);
  writeHiveStateSnapshot(state);

  // Emit compact progress to the shared conversation log every ~2s. Child processes
  // also mirror progress into the shared conversation log so the top-level
  // status modal can surface nested lead→member work.
  const mirrorProgressToConversation = process.env.PI_HIVE_CHILD === "1";
  let progressTick = 0;
  runtime.timer = setInterval(() => {
    runtime.elapsedMs = runtime.startedAt ? Date.now() - runtime.startedAt : runtime.elapsedMs;
    publishRuntimeUpdate(state);
    writeHiveStateSnapshot(state);
    // every ~2s, not every second, to keep logs light
    if (++progressTick % 2 === 0) {
      const progress = {
        from: runtime.config.name,
        type: "progress",
        inputTokens: runtime.inputTokens,
        outputTokens: runtime.outputTokens,
        costUsd: runtime.costUsd,
        elapsedMs: runtime.elapsedMs,
      };
      if (mirrorProgressToConversation) logRecord(state, progress);
    }
  }, 1000);
  runtime.timer.unref?.();

  const args = [
    "--mode", "json",
    "-p",
    "--model", model,
    "--tools", tools,
    "--thinking", thinking,
    "--append-system-prompt", prompt,
    "--session", runtime.sessionFile,
  ];
  if (hasExistingSession) args.push("-c");
  args.push(task);

  const chunks: string[] = [];
  const stderrChunks: string[] = [];

  return new Promise((resolve) => {
    const { proc } = spawnManaged("pi", args, {
      cwd: ctx.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_HIVE_CHILD: "1",
        PI_HIVE_PARENT_AGENT: currentAgentName(),
        PI_HIVE_CURRENT_AGENT: runtime.config.name,
        PI_HIVE_SESSION_ID: state.session!.sessionId,
        PI_HIVE_SESSION_DIR: state.session!.sessionDir,
        PI_HIVE_CONVERSATION_LOG: state.session!.conversationLog,
        PI_HIVE_OBSERVABILITY_LOG: state.session!.observabilityLog,
      },
    });
    let buffer = "";

    const consumeEvent = (event: any) => {
      if (event.type === "message_update") {
        const delta = event.assistantMessageEvent;
        const text = delta?.delta || delta?.text || "";
        if (delta?.type === "text_delta" && text) {
          chunks.push(text);
          const last = chunks.join("").split("\n").filter((line) => line.trim()).pop();
          if (last) runtime.lastWork = last;
        }
      } else if (event.type === "tool_execution_start") {
        runtime.toolCount++;
        runtime.lastWork = `tool: ${event.toolName || event.name || "unknown"}`;
        emitHiveEvent(state, "worker_tool_start", { agent: runtime.config.name, toolName: event.toolName || event.name || "unknown", toolCallId: event.toolCallId }, runtime.config.name);
      } else if (event.type === "tool_execution_end") {
        emitHiveEvent(state, "worker_tool_end", { agent: runtime.config.name, toolName: event.toolName || event.name || "unknown", toolCallId: event.toolCallId, isError: event.isError === true }, runtime.config.name);
      } else if (event.type === "message_end") {
        const usage = event.message?.usage;
        if (usage) {
          const u = extractUsage(usage);
          runtime.inputTokens += u.input;
          runtime.outputTokens += u.output;
          runtime.costUsd += u.cost;
        }
      } else if (event.type === "agent_end") {
        const messages = event.messages || [];
        const last = [...messages].reverse().find((message: any) => message.role === "assistant");
        if (last && !chunks.length) chunks.push(textFromMessage(last));
        if (last?.usage) {
          const u = extractUsage(last.usage);
          runtime.inputTokens += u.input;
          runtime.outputTokens += u.output;
          runtime.costUsd += u.cost;
        }
      }
      publishRuntimeUpdate(state);
      writeHiveStateSnapshot(state);
    };

    proc.stdout?.setEncoding("utf-8");
    proc.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try { consumeEvent(JSON.parse(line)); } catch { /* ignore non-json */ }
      }
    });

    proc.stderr?.setEncoding("utf-8");
    proc.stderr?.on("data", (chunk: string) => stderrChunks.push(chunk));

    const finish = (code: number | null) => {
      if (buffer.trim()) {
        try { consumeEvent(JSON.parse(buffer)); } catch { /* ignore */ }
      }
      if (runtime.timer) clearInterval(runtime.timer);
      runtime.elapsedMs = runtime.startedAt ? Date.now() - runtime.startedAt : runtime.elapsedMs;
      runtime.status = code === 0 ? "done" : "error";
      state.activeRuns = Math.max(0, state.activeRuns - 1);

      const output = chunks.join("").trim() || stderrChunks.join("").trim() || "[no output]";
      runtime.lastWork = output.split("\n").filter((line) => line.trim()).pop() || runtime.status;
      // The shared log keeps only a bounded summary of the result — the full
      // output is returned to the caller and persisted in this agent's own
      // transcript (agents/<slug>.jsonl). Logging the whole thing here is what
      // turned the shared log into a multi-hundred-KB-per-line firehose.
      const completion = {
        from: runtime.config.name,
        to: "Orchestrator",
        type: runtime.status,
        message: truncateMiddle(output, 2_000),
        costUsd: runtime.costUsd,
        inputTokens: runtime.inputTokens,
        outputTokens: runtime.outputTokens,
        elapsedMs: runtime.elapsedMs,
      };
      logRecord(state, completion);
      emitHiveEvent(state, "delegation_end", { ...completion, exitCode: code ?? 1, runtime: runtimeSummary(runtime) }, runtime.config.name);
      publishRuntimeUpdate(state);
      writeHiveStateSnapshot(state);
      state.onRuntimeFinish?.(runtime, ctx);
      resolve({ output, exitCode: code ?? 1, elapsed: runtime.elapsedMs });
    };

    proc.on("close", finish);
    proc.on("error", (error: Error) => {
      stderrChunks.push(error.message);
      finish(1);
    });
  });
}

// ── Mental-model distiller ────────────────────────────────────────────────
// After a worker finishes, a separate constrained `pi` run reads a SNAPSHOT of
// the just-completed conversation plus the agent's current mental model, then
// returns a consolidated rewrite of that file. This replaces inline self-update
// tools: the worker focuses on the task; memory is curated out-of-band, can
// consolidate (not just append), and never pollutes the worker's context.

export async function runDistillerProcess(state: HiveState, ctx: ExtensionContext, prompt: string, model: string): Promise<string> {
  const args = ["--mode", "json", "-p", "--model", model, "--tools", "", "--thinking", "off", prompt];
  return new Promise((resolveProc) => {
    // Inherit the parent's session so the distiller never mints its own session
    // dir. It runs with no team tools, so it does no team work — it only needs to
    // be recognized as an in-session child (PI_HIVE_CHILD) pointed at the
    // live session, not a fresh one.
    const { proc } = spawnManaged("pi", args, {
      cwd: ctx.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_HIVE_CHILD: "1",
        PI_HIVE_PARENT_AGENT: "Distiller",
        PI_HIVE_CURRENT_AGENT: "Distiller",
        ...(state.session
          ? {
              PI_HIVE_SESSION_ID: state.session.sessionId,
              PI_HIVE_SESSION_DIR: state.session.sessionDir,
              PI_HIVE_CONVERSATION_LOG: state.session.conversationLog,
              PI_HIVE_OBSERVABILITY_LOG: state.session.observabilityLog,
            }
          : {}),
      },
    });
    const chunks: string[] = [];
    let buffer = "";
    const consume = (event: any) => {
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        chunks.push(event.assistantMessageEvent.delta || event.assistantMessageEvent.text || "");
      } else if (event.type === "agent_end") {
        const last = [...(event.messages || [])].reverse().find((m: any) => m.role === "assistant");
        if (last && !chunks.length) chunks.push(textFromMessage(last));
      }
    };
    proc.stdout?.setEncoding("utf-8");
    proc.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) { if (line.trim()) { try { consume(JSON.parse(line)); } catch { /* ignore */ } } }
    });
    proc.on("error", () => resolveProc(""));
    proc.on("close", () => {
      if (buffer.trim()) { try { consume(JSON.parse(buffer)); } catch { /* ignore */ } }
      resolveProc(chunks.join("").trim());
    });
  });
}

export async function distillMentalModel(state: HiveState, ctx: ExtensionContext, runtime: AgentRuntime): Promise<void> {
  if (!state.config || !state.session || !state.config.settings.distiller.enabled) return;
  const target = agentMentalModelTarget(runtime);
  if (!target) return;

  // Write guard: the mental-model file must live under the agents/ root.
  const agentsRoot = resolve(ctx.cwd, HIVE_AGENTS_DIR);
  const targetPath = resolve(ctx.cwd, target.path);
  if (!targetPath.startsWith(agentsRoot)) return;

  // Snapshot the just-finished conversation, distill from the copy, then delete
  // it — so a re-delegation of the same agent can reuse its live session freely.
  const snapshotDir = join(state.session.sessionDir, "distill");
  ensureDir(snapshotDir);
  const snapshotPath = join(snapshotDir, `${slug(runtime.config.name)}-${runtime.runCount}.jsonl`);
  let conversation = "";
  try {
    if (existsSync(runtime.sessionFile)) {
      copyFileSync(runtime.sessionFile, snapshotPath);
      conversation = tailLines(safeRead(snapshotPath), state.config.settings.distiller.conversationLines);
    }
  } catch { /* no session yet */ }
  if (!conversation) { try { rmSync(snapshotPath, { force: true }); } catch { /* noop */ } return; }

  try {
    const currentModel = safeRead(targetPath);
    const today = new Date().toISOString().slice(0, 10);
    const prompt = buildDistillerPrompt(runtime.config.name, currentModel, conversation, today);
    emitHiveEvent(state, "distill_start", { agent: runtime.config.name, target: target.path, model: state.config.settings.distiller.model }, "Distiller");
    const output = await runDistillerProcess(state, ctx, prompt, state.config.settings.distiller.model);
    const extracted = extractTagged(output, "mental_model");
    // Mechanical safety net: guarantee the hard spine (owner/updated/spine keys)
    // even if the distiller's output drifts. The soft body is left byte-exact.
    const distilled = extracted ? normalizeMentalModelSpine(extracted, runtime.config.name).trim() : null;
    if (distilled && distilled !== currentModel.trim()) {
      writeFileSync(targetPath, `${distilled}\n`);
      logRecord(state, { from: "Distiller", to: runtime.config.name, type: "mental_model_distilled", message: `Updated ${target.path}`, path: target.path });
      emitHiveEvent(state, "distill_end", { agent: runtime.config.name, target: target.path, changed: true }, "Distiller");
    }
  } catch { /* distillation is best-effort; never fail the delegation */ }
  finally { try { rmSync(snapshotPath, { force: true }); } catch { /* noop */ } }
}
