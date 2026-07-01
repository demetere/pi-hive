import * as path from "node:path";
import { PROJECT_CWD } from "./config";
import { sessionSummaries } from "./runtime";
import { randomUUID } from "node:crypto";
import { insertPlanApproval, insertPlanComment, listApprovals, listComments, latestVerdict, listVerdicts } from "./db";
import {
  changeExists,
  listArtifacts,
  listChangeIds,
  proposalTitle,
  readPlanMeta,
  resolveArtifact,
} from "../../engine/plan-store";
import { readIfSmall } from "../../core/utils";
import { PLAN_GATES } from "../../engine/sdd";

// The plan-store lives per-project under <cwd>/.pi/hive/plans/. The dashboard is
// global, so plan endpoints take a cwd — but only a cwd that belongs to a known
// telemetry session (or the boot project) is honored, so a same-origin caller
// cannot point the reader at an arbitrary filesystem path.
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
  return knownCwds().includes(target) ? target : (knownCwds().length ? null : fallback);
}

// Derived phase = first missing gate; all present ⇒ "ready".
function derivePhase(cwd: string, changeId: string): { phase: string; gates: Array<{ gate: string; present: boolean }> } {
  const artifacts = new Set(listArtifacts(cwd, changeId));
  const gates = (PLAN_GATES as readonly string[]).map((gate) => ({ gate, present: artifacts.has(`${gate}.md`) }));
  const missing = gates.find((g) => !g.present);
  return { phase: missing ? missing.gate : "ready", gates };
}

export interface PlanSummary {
  changeId: string;
  title?: string;
  phase: string;
  status?: string;
  owner?: string;
  artifacts: string[];
  latestVerdict: ReturnType<typeof latestVerdict>;
}

export function listPlans(cwd: string): PlanSummary[] {
  return listChangeIds(cwd).map((changeId) => {
    const meta = readPlanMeta(cwd, changeId);
    const { phase } = derivePhase(cwd, changeId);
    return {
      changeId,
      title: meta.title || proposalTitle(cwd, changeId),
      phase,
      status: meta.status,
      owner: meta.owner,
      artifacts: listArtifacts(cwd, changeId),
      latestVerdict: latestVerdict(changeId),
    };
  });
}

export function planDetail(cwd: string, changeId: string) {
  if (!changeExists(cwd, changeId)) return null;
  const meta = readPlanMeta(cwd, changeId);
  const { phase, gates } = derivePhase(cwd, changeId);
  return {
    changeId,
    title: meta.title || proposalTitle(cwd, changeId),
    status: meta.status,
    owner: meta.owner,
    phase,
    gates,
    artifacts: listArtifacts(cwd, changeId),
    verdicts: listVerdicts(changeId),
    approvals: listApprovals(changeId),
    comments: listComments(changeId),
  };
}

// Read one artifact's markdown, path-guarded to the change folder. Returns null
// on traversal or unreadable file.
export function planFile(cwd: string, changeId: string, relPath: string): { path: string; content: string } | null {
  if (!changeExists(cwd, changeId)) return null;
  const abs = resolveArtifact(cwd, changeId, relPath);
  if (!abs) return null;
  const content = readIfSmall(abs, 512_000);
  return { path: relPath, content };
}

// ── UI writes (same-origin-guarded at the endpoint) ─────────────────────────
// Comments/approvals from the dashboard are written directly to SQLite (the
// server is Bun). Verdicts are NOT written here — they only ever originate from
// a reviewer's tool, materialized from the review_verdict event on ingest.

export function addComment(cwd: string, changeId: string, body: { file?: string; anchor?: string; author?: string; body: string }): { ok: boolean; id?: string; error?: string } {
  if (!changeExists(cwd, changeId)) return { ok: false, error: "unknown change" };
  const text = String(body.body || "").trim();
  if (!text) return { ok: false, error: "empty comment" };
  const id = randomUUID();
  insertPlanComment({
    id,
    changeId,
    file: body.file ? String(body.file) : undefined,
    anchor: body.anchor ? String(body.anchor) : undefined,
    author: body.author ? String(body.author) : undefined,
    body: text,
    createdAt: new Date().toISOString(),
  });
  return { ok: true, id };
}

export function addApproval(cwd: string, changeId: string, body: { phase?: string; actor?: string; summary?: string }): { ok: boolean; id?: string; error?: string } {
  if (!changeExists(cwd, changeId)) return { ok: false, error: "unknown change" };
  const phase = String(body.phase || "").trim();
  if (!(PLAN_GATES as readonly string[]).includes(phase)) return { ok: false, error: `phase must be one of ${PLAN_GATES.join(", ")}` };
  const id = randomUUID();
  insertPlanApproval({
    id,
    changeId,
    phase,
    approvedBy: "ui",
    actor: body.actor ? String(body.actor) : undefined,
    summary: body.summary ? String(body.summary) : undefined,
    createdAt: new Date().toISOString(),
  });
  return { ok: true, id };
}
