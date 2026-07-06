import * as openspec from "../../engine/openspec";
import { latestVerdict, listVerdicts } from "./db";

// OpenSpec-backed read routes for the dashboard, replacing the deleted
// in-house plan-store server routes (plans.ts). The dashboard is global, so each
// takes a validated project cwd (resolveProjectCwd, from plan-bridge).

export interface PlanSummary {
  changeId: string;
  status: openspec.ChangeTaskStatus;
  completedTasks: number;
  totalTasks: number;
  lastModified?: string;
  latestVerdict: ReturnType<typeof latestVerdict>;
}

export function listPlans(cwd: string): PlanSummary[] {
  return openspec.listChanges(cwd).map((c) => ({
    changeId: c.name,
    status: c.status,
    completedTasks: c.completedTasks,
    totalTasks: c.totalTasks,
    lastModified: c.lastModified,
    latestVerdict: latestVerdict(c.name, cwd),
  }));
}

// Per-artifact review state encoding the two-stage flow: the reviewer AGENT
// vets an authored artifact first (a non-"ui" verdict), and only once it clears
// does the artifact become ready for the HUMAN to sign off in the dashboard.
export interface ArtifactReview {
  id: string;                 // proposal | design | specs | tasks
  authored: boolean;          // exists on disk
  agentCleared: boolean;      // reviewer agent gave a standing green
  humanVerdict: "green" | "red" | null; // the human's per-artifact ledger entry
  humanReviewReady: boolean;  // authored + agent-cleared + not yet human-approved
}

export interface PlanDetail {
  changeId: string;
  artifacts: openspec.ArtifactState[];
  artifactReview: ArtifactReview[];
  nextReady: string | null;
  files: string[];
  validation: { passed: boolean; failed: number; issues: openspec.ValidateIssue[] };
  readyToExecute: boolean;
  verdicts: ReturnType<typeof listVerdicts>;
}

// The reviewer AGENT's standing verdict for an artifact. The sidecar is the
// source of truth for new reviews because it is keyed by artifact and readable
// by the core dispatch gate. Fall back to old change-level SQLite verdicts only
// when no sidecar agent-review state exists at all (legacy sessions).
function agentClearedArtifact(cwd: string, changeId: string, artifact: string): boolean {
  const sidecarVerdict = openspec.agentReviewVerdict(cwd, changeId, artifact);
  if (sidecarVerdict) return sidecarVerdict === "green" || sidecarVerdict === "yellow";
  if (Object.keys(openspec.readAgentReviewLedger(cwd, changeId)).length > 0) return false;

  const verdicts = listVerdicts(changeId, cwd).filter((v) => v.reviewer !== "ui");
  if (!verdicts.length) return false;
  return verdicts[0].verdict === "green" || verdicts[0].verdict === "yellow";
}

export function planDetail(cwd: string, changeId: string): PlanDetail | null {
  if (!openspec.changeExists(cwd, changeId)) return null;
  const detail = openspec.changeDetail(cwd, changeId);
  if (!detail) return null;
  const validation = openspec.validate(cwd, changeId);
  const artifactReview: ArtifactReview[] = detail.artifacts.map((a) => {
    const authored = a.status === "done";
    const humanVerdict = openspec.artifactVerdict(cwd, changeId, a.id);
    const agentCleared = authored && agentClearedArtifact(cwd, changeId, a.id);
    return {
      id: a.id,
      authored,
      agentCleared,
      humanVerdict,
      humanReviewReady: authored && agentCleared && humanVerdict !== "green",
    };
  });
  return {
    changeId,
    artifacts: detail.artifacts,
    artifactReview,
    nextReady: detail.nextReady,
    files: openspec.listArtifacts(cwd, changeId),
    validation,
    readyToExecute: openspec.isReadyToExecute(cwd, changeId),
    verdicts: listVerdicts(changeId, cwd),
  };
}

export interface PlanFile {
  content: string | null;
  truncated: boolean;
  size: number;
}

const MAX_FILE_BYTES = 512_000;

export function planFile(cwd: string, changeId: string, relPath: string): PlanFile | null {
  const target = openspec.resolveArtifact(cwd, changeId, relPath);
  if (!target) return null;
  const content = openspec.readArtifact(cwd, changeId, relPath);
  const size = Buffer.byteLength(content, "utf8");
  if (size > MAX_FILE_BYTES) return { content: null, truncated: true, size };
  return { content, truncated: false, size };
}
