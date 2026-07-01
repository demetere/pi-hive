import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JsonRecord, HiveState } from "../core/types";
import { ensureDir } from "../core/utils";

export function createState(pi: ExtensionAPI): HiveState {
  return {
    pi,
    config: null,
    session: null,
    runtimes: new Map(),
    widgetCtx: null,
    activeRuns: 0,
    mode: "normal",
    normalToolNames: [],
    streamStartMs: 0,
    streamedChars: 0,
    lastTokPerSec: 0,
    sddStatus: null,
    obsSeq: 0,
    latestVerdicts: new Map(),
  };
}

export function logRecord(state: HiveState, record: JsonRecord) {
  if (!state.session) return;
  ensureDir(dirname(state.session.conversationLog));
  // Stamp the writing process. The top-level orchestrator tails this shared log
  // to surface child-dispatched (nested) agents in its status view; the `pid`
  // lets it skip records it wrote itself (already reflected in its runtimes) and
  // apply only those from child worker processes.
  appendFileSync(state.session.conversationLog, `${JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid, ...record })}\n`);
}
