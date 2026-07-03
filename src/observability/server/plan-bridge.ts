import * as path from "node:path";
import { appendFileSync } from "node:fs";
import { PROJECT_CWD } from "./config";
import { sessionSummaries } from "./runtime";
import { ensureDir } from "../../core/fs";

// Shared plan/review infrastructure for the (Bun) dashboard server: project-cwd
// scoping and the dashboard-actions.jsonl bridge producer. Extracted so it
// survives the removal of the in-house plan-store server routes — both the
// OpenSpec-backed review surface (src/engine/review.ts) and the questions loop
// enqueue session round-trips through here.

// The OpenSpec store lives per-project under <cwd>/openspec/. The dashboard is
// global, so plan/review endpoints take a cwd — but only a cwd that belongs to a
// known telemetry session (or the boot project) is honored, so a same-origin
// caller cannot point the reader at an arbitrary filesystem path.
export function knownCwds(): string[] {
  const set = new Set<string>();
  if (PROJECT_CWD) set.add(path.resolve(PROJECT_CWD));
  for (const summary of sessionSummaries()) if (summary.cwd) set.add(path.resolve(summary.cwd));
  return Array.from(set);
}

export function resolveProjectCwd(requested: string | null): string | null {
  const fallback = PROJECT_CWD ? path.resolve(PROJECT_CWD) : null;
  if (!requested) return fallback;
  const target = path.resolve(requested);
  return knownCwds().includes(target) ? target : knownCwds().length ? null : fallback;
}

// Append an action to the target session's dashboard-actions.jsonl, which the
// live TUI session polls (startDashboardActionPoller). Targets the session that
// owns the change when known (matching sessionId), else the most-recently-active
// session in the same project. Used for review deny -> planner feedback and the
// questions loop.
export function enqueueDashboardAction(
  cwd: string,
  action: Record<string, unknown>,
  ownerSessionId?: string,
): boolean {
  const sessions = sessionSummaries().filter((s) => path.resolve(s.cwd || "") === path.resolve(cwd));
  const target =
    (ownerSessionId && sessions.find((s) => s.session_id === ownerSessionId)) ||
    sessions.sort((a, b) => String(b.last_ts || "").localeCompare(String(a.last_ts || "")))[0];
  if (!target?.session_dir) return false;
  const file = path.join(target.session_dir, "dashboard-actions.jsonl");
  ensureDir(path.dirname(file));
  appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...action })}\n`);
  return true;
}
