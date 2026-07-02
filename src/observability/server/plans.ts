import * as path from "node:path";
import { appendFileSync, writeFileSync } from "node:fs";
import { PROJECT_CWD } from "./config";
import { sessionSummaries } from "./runtime";
import { randomUUID } from "node:crypto";
import { insertPlanApproval, insertPlanComment, listApprovals, listComments, latestVerdict, listVerdicts } from "./db";
import {
  changeDir,
  changeExists,
  listArtifacts,
  listChangeIds,
  proposalTitle,
  readPlanMeta,
  resolveArtifact,
} from "../../engine/plan-store";
import { ensureDir, readIfSmall } from "../../core/utils";
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
  sessionId?: string;
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
      sessionId: meta.sessionId,
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
    sessionId: meta.sessionId,
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

export function addComment(cwd: string, changeId: string, body: { file?: string; anchor?: string; author?: string; body: string; annotationType?: string; originalText?: string }): { ok: boolean; id?: string; error?: string } {
  if (!changeExists(cwd, changeId)) return { ok: false, error: "unknown change" };
  const text = String(body.body || "").trim();
  if (!text) return { ok: false, error: "empty comment" };
  const id = randomUUID();
  const file = body.file ? String(body.file) : undefined;
  const anchor = body.anchor ? String(body.anchor) : undefined;
  const author = body.author ? String(body.author) : undefined;
  const annotationType = body.annotationType ? String(body.annotationType) : undefined;
  const originalText = body.originalText ? String(body.originalText) : undefined;
  const createdAt = new Date().toISOString();
  insertPlanComment({ id, changeId, file, anchor, author, body: text, annotationType, originalText, createdAt });
  enqueueDashboardAction(cwd, changeId, { type: "plan_comment", id, changeId, file, anchor, body: text, annotationType, originalText });
  return { ok: true, id };
}

const NEXT_PHASE: Record<string, string> = { proposal: "requirements", requirements: "design", design: "tasks", tasks: "apply" };

function renderPlanYaml(meta: { title?: string; status?: string; phase?: string; owner?: string; sessionId?: string }): string {
  return [
    `title: ${JSON.stringify(meta.title || "")}`,
    `status: ${meta.status || "planning"}`,
    `phase: ${meta.phase || "proposal"}`,
    `owner: ${JSON.stringify(meta.owner || "")}`,
    ...(meta.sessionId ? [`session_id: ${JSON.stringify(meta.sessionId)}`] : []),
  ].join("\n") + "\n";
}

function approveGateSync(cwd: string, changeId: string, phase: string) {
  const current = readPlanMeta(cwd, changeId);
  const expectedPhase = current.phase || "proposal";
  if (phase !== expectedPhase) return { ...current, advanced: false };
  const next = { ...current, status: phase === "tasks" ? "ready" : "planning", phase: NEXT_PHASE[phase] || phase, advanced: true };
  writeFileSync(path.join(changeDir(cwd, changeId), "plan.yaml"), renderPlanYaml(next));
  return next;
}

function enqueueDashboardAction(cwd: string, changeId: string, action: Record<string, unknown>) {
  const meta = readPlanMeta(cwd, changeId);
  const sessions = sessionSummaries().filter((s) => path.resolve(s.cwd || "") === path.resolve(cwd));
  const target = (meta.sessionId && sessions.find((s) => s.session_id === meta.sessionId)) || sessions.sort((a, b) => String(b.last_ts || "").localeCompare(String(a.last_ts || "")))[0];
  if (!target?.session_dir) return;
  const file = path.join(target.session_dir, "dashboard-actions.jsonl");
  ensureDir(path.dirname(file));
  appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...action })}\n`);
}

export function addApproval(cwd: string, changeId: string, body: { phase?: string; actor?: string; summary?: string }): { ok: boolean; id?: string; error?: string } {
  if (!changeExists(cwd, changeId)) return { ok: false, error: "unknown change" };
  const phase = String(body.phase || "").trim();
  if (!(PLAN_GATES as readonly string[]).includes(phase)) return { ok: false, error: `phase must be one of ${PLAN_GATES.join(", ")}` };
  try {
    const nextMeta = approveGateSync(cwd, changeId, phase);
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    insertPlanApproval({
      id,
      changeId,
      phase,
      approvedBy: "ui",
      actor: body.actor ? String(body.actor) : undefined,
      summary: body.summary ? String(body.summary) : undefined,
      createdAt,
    });
    if (nextMeta.advanced) enqueueDashboardAction(cwd, changeId, { type: "plan_approval", id, changeId, phase, nextPhase: nextMeta.phase, status: nextMeta.status });
    return { ok: true, id };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
