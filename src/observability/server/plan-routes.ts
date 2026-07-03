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

export interface PlanDetail {
  changeId: string;
  artifacts: openspec.ArtifactState[];
  nextReady: string | null;
  files: string[];
  validation: { passed: boolean; failed: number; issues: openspec.ValidateIssue[] };
  readyToExecute: boolean;
  verdicts: ReturnType<typeof listVerdicts>;
}

export function planDetail(cwd: string, changeId: string): PlanDetail | null {
  if (!openspec.changeExists(cwd, changeId)) return null;
  const detail = openspec.changeDetail(cwd, changeId);
  if (!detail) return null;
  const validation = openspec.validate(cwd, changeId);
  return {
    changeId,
    artifacts: detail.artifacts,
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
