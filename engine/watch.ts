import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { open } from "node:fs/promises";
import type { HiveState } from "../core/types";
import { usageNumber } from "../core/utils";
import { updateWidget } from "../ui/tui/widget";
import { writeHiveStateSnapshot } from "./observability";

// ── Nested-activity watcher ────────────────────────────────────────────────
// Members are dispatched by their LEAD, which runs as a separate `pi`
// subprocess. That subprocess accumulates the member's status/tokens in its OWN
// in-memory runtimes — invisible to the top-level orchestrator process whose
// status modal the user sees. So nested agents always looked idle.
//
// The fix: every process appends delegation/result records (stamped with its
// pid) to the SHARED conversation log. The top-level process tails that log and
// reflects records written by OTHER pids into its own runtimes, so the modal
// shows the whole tree live — who is running, and cumulative tokens/cost — no
// matter which process actually dispatched each agent.

interface WatchState {
  watcher?: FSWatcher;
  offset: number;
  reading: boolean;
  pending: boolean;
  buffer: string;
}

const WATCHERS = new WeakMap<HiveState, WatchState>();

function applyRecord(state: HiveState, record: any): boolean {
  // Only nested records from a different process matter; anything this process
  // dispatched is already reflected directly by dispatchAgent.
  if (!record || typeof record !== "object") return false;
  if (record.pid && record.pid === process.pid) return false;

  const type = String(record.type || "");

  if (type === "delegation") {
    const target = String(record.to || "").toLowerCase();
    const runtime = state.runtimes.get(target);
    if (!runtime) return false;
    runtime.status = "running";
    runtime.task = String(record.message || runtime.task || "");
    runtime.lastWork = runtime.task;
    runtime.runCount++;
    runtime.startedAt = Date.parse(record.timestamp) || Date.now();
    runtime.elapsedMs = 0;
    return true;
  }

  // Periodic running totals from a nested agent's own process. The record
  // carries CUMULATIVE totals for that agent, so REPLACE (not add) — otherwise
  // each tick would stack on the last. Keeps the agent "running" and lets its
  // tokens/cost climb live in the modal.
  if (type === "progress") {
    const source = String(record.from || "").toLowerCase();
    const runtime = state.runtimes.get(source);
    if (!runtime) return false;
    if (runtime.status !== "running") runtime.status = "running";
    runtime.inputTokens = usageNumber(record.inputTokens);
    runtime.outputTokens = usageNumber(record.outputTokens);
    runtime.costUsd = usageNumber(record.costUsd);
    if (usageNumber(record.elapsedMs) > 0) runtime.elapsedMs = usageNumber(record.elapsedMs);
    return true;
  }

  if (type === "done" || type === "error") {
    const source = String(record.from || "").toLowerCase();
    const runtime = state.runtimes.get(source);
    if (!runtime) return false;
    runtime.status = type === "done" ? "done" : "error";
    // The done record also carries CUMULATIVE totals — REPLACE, consistent with
    // `progress` above. (Adding here would double-count whatever the last
    // progress tick already set.)
    runtime.inputTokens = usageNumber(record.inputTokens);
    runtime.outputTokens = usageNumber(record.outputTokens);
    runtime.costUsd = usageNumber(record.costUsd);
    if (usageNumber(record.elapsedMs) > 0) runtime.elapsedMs = usageNumber(record.elapsedMs);
    runtime.startedAt = undefined;
    if (typeof record.message === "string" && record.message.trim()) {
      runtime.lastWork = record.message.split("\n").filter((line: string) => line.trim()).pop() || runtime.lastWork;
    }
    return true;
  }

  return false;
}

async function drain(state: HiveState, ws: WatchState) {
  if (ws.reading) { ws.pending = true; return; }
  ws.reading = true;
  try {
    const path = state.session?.conversationLog;
    if (!path || !existsSync(path)) return;
    let size = 0;
    try { size = statSync(path).size; } catch { return; }
    // The log was truncated/rotated (new session) — restart from the top.
    if (size < ws.offset) { ws.offset = 0; ws.buffer = ""; }
    if (size === ws.offset) return;

    const handle = await open(path, "r");
    try {
      const length = size - ws.offset;
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, ws.offset);
      ws.offset = size;
      ws.buffer += buf.toString("utf-8");
    } finally {
      await handle.close();
    }

    const lines = ws.buffer.split("\n");
    ws.buffer = lines.pop() || "";
    let changed = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      try { if (applyRecord(state, JSON.parse(line))) changed = true; } catch { /* ignore non-json */ }
    }
    if (changed) {
      updateWidget(state);
      writeHiveStateSnapshot(state);
    }
  } finally {
    ws.reading = false;
    if (ws.pending) { ws.pending = false; void drain(state, ws); }
  }
}

export function startConversationWatch(state: HiveState) {
  if (!state.session) return;
  // Child processes never render the modal; only the top-level orchestrator
  // watches. (Child runtimes are short-lived and self-account anyway.)
  if (process.env.PI_HIVE_CHILD === "1") return;
  stopConversationWatch(state);

  const path = state.session.conversationLog;
  // Start at the current end of file: only records written AFTER this point are
  // nested activity we need to mirror. Existing history is already accounted for.
  let offset = 0;
  try { if (existsSync(path)) offset = statSync(path).size; } catch { /* fresh */ }
  const ws: WatchState = { offset, reading: false, pending: false, buffer: "" };
  WATCHERS.set(state, ws);

  try {
    ws.watcher = watch(path, { persistent: false }, () => { void drain(state, ws); });
  } catch {
    // The file may not exist yet; watch the directory entry lazily on first poll.
  }
  // Safety poll: fs.watch can miss events on some platforms/filesystems.
  const poll = setInterval(() => { void drain(state, ws); }, 1000);
  poll.unref?.();
  (ws as any).poll = poll;
}

export function stopConversationWatch(state: HiveState) {
  const ws = WATCHERS.get(state);
  if (!ws) return;
  try { ws.watcher?.close(); } catch { /* noop */ }
  const poll = (ws as any).poll as ReturnType<typeof setInterval> | undefined;
  if (poll) clearInterval(poll);
  WATCHERS.delete(state);
}
