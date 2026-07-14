import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { slug } from "../core/utils";
import type { JsonRecord, HiveState } from "../core/types";
import { redactSensitive } from "../shared/privacy";

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function createState(pi: ExtensionAPI): HiveState {
  return {
    pi,
    config: null,
    session: null,
    runtimes: new Map(),
    widgetCtx: null,
    activeRuns: 0,
    workerQueue: [],
    nextQueueId: 0,
    budgetWarnings: new Set(),
    mode: "normal",
    normalToolNames: [],
    sddStatus: null,
    obsSeq: 0,
    latestVerdicts: new Map(),
    shuttingDown: false,
    lifecycleGeneration: 0,
    backgroundTasks: new Set(),
    distillQueues: new Map(),
    backgroundDistillerSessions: new Set(),
    orchestratorRuntime: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, toolCount: 0, status: "idle", elapsedMs: 0 },
  };
}

export function logRecord(state: HiveState, record: JsonRecord) {
  if (!state.session) return;
  ensurePrivateDir(dirname(state.session.conversationLog));
  // Stamp the writing process. The top-level orchestrator tails this shared log
  // to surface child-dispatched (nested) agents in its status view; the `pid`
  // lets it skip records it wrote itself (already reflected in its runtimes) and
  // apply only those from child worker processes.
  const row = redactSensitive(
    { timestamp: new Date().toISOString(), pid: process.pid, ...record },
    state.config?.settings?.telemetry?.redactSensitiveData !== false,
  );
  appendFileSync(state.session.conversationLog, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  chmodSync(state.session.conversationLog, 0o600);

  // Also keep a focused transcript for the visible main session agent
  // (Planning Lead / Orchestrator / custom root). conversation.jsonl remains the
  // complete team log; this file powers clicking the root node in the topology.
  const mainName = state.config?.orchestrator?.name || "Orchestrator";
  const from = String((record as any).from || "");
  const to = String((record as any).to || "");
  // The main session may be logged under its configured name or the generic
  // "Orchestrator" alias (H3: no hardcoded "Planning Lead" special-case — a
  // planning-team main node is matched by mainName, which is its actual name).
  const isMainAlias = (name: string) => name === mainName || name === "Orchestrator";
  const include = from === "User" || from === "System" || isMainAlias(from) || isMainAlias(to);
  if (!include) return;
  const runtimeFile = Array.from(state.runtimes.values()).find((runtime) => runtime.config.name === mainName || runtime.config.slug === mainName)?.sessionFile;
  const mainFile = runtimeFile || `${state.session.sessionDir}/agents/${slug(mainName)}.jsonl`;
  ensurePrivateDir(dirname(mainFile));
  appendFileSync(mainFile, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  chmodSync(mainFile, 0o600);
}
