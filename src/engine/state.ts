import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { slug } from "../core/utils";
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
  const row = { timestamp: new Date().toISOString(), pid: process.pid, ...record };
  appendFileSync(state.session.conversationLog, `${JSON.stringify(row)}\n`);

  // Also keep a focused transcript for the visible main session agent
  // (Planning Lead / Orchestrator / custom root). conversation.jsonl remains the
  // complete team log; this file powers clicking the root node in the topology.
  const mainName = state.config?.orchestrator?.name || "Orchestrator";
  const from = String((record as any).from || "");
  const to = String((record as any).to || "");
  const isMainAlias = (name: string) => name === mainName || name === "Orchestrator" || name === "Planning Lead";
  const include = from === "User" || from === "System" || isMainAlias(from) || isMainAlias(to);
  if (!include) return;
  const runtimeFile = state.runtimes.get(mainName.toLowerCase())?.sessionFile;
  const mainFile = runtimeFile || `${state.session.sessionDir}/agents/${slug(mainName)}.jsonl`;
  ensureDir(dirname(mainFile));
  appendFileSync(mainFile, `${JSON.stringify(row)}\n`);
}
