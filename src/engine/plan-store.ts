import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HIVE_PLANS_DIR } from "../core/constants";
import { ensureDir, readIfSmall, safeRead } from "../core/utils";
import { parseFrontmatter, parseYamlLite } from "../core/yaml";

// Node's Dirent, declared locally because the core tsconfig loads no @types/node
// (matches the pattern in sdd.ts).
type FsDirent = { name: string; isDirectory(): boolean; isFile(): boolean };

// Filesystem operations for the plan store under .pi/hive/plans/<change-id>/.
// Pure Node fs (no Bun) so the core can create/select plans without the
// dashboard. Verdicts/approvals/comments live in SQLite (dashboard); the
// markdown artifacts and plan.yaml metadata live here.

export interface PlanMeta {
  title?: string;
  status?: string;
  phase?: string;
  owner?: string;
  sessionId?: string;
}

export function plansRoot(cwd: string): string {
  return resolve(cwd, HIVE_PLANS_DIR);
}

const CHANGE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isSafeChangeId(changeId: string): boolean {
  return CHANGE_ID_RE.test(changeId);
}

export function assertSafeChangeId(changeId: string): void {
  if (!isSafeChangeId(changeId)) {
    throw new Error(`Invalid change-id "${changeId}". Change IDs must be lowercase kebab-case letters/numbers, for example "add-auth".`);
  }
}

export function changeDir(cwd: string, changeId: string): string {
  assertSafeChangeId(changeId);
  return resolve(plansRoot(cwd), changeId);
}

export function changeExists(cwd: string, changeId: string): boolean {
  return isSafeChangeId(changeId) && existsSync(changeDir(cwd, changeId));
}

export function listChangeIds(cwd: string): string[] {
  try {
    return (readdirSync(plansRoot(cwd), { withFileTypes: true }) as FsDirent[])
      .filter((entry) => entry.isDirectory() && entry.name !== "archive" && isSafeChangeId(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

// Normalize a user-supplied title/id into a stable kebab change-id.
export function toChangeId(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function renderPlanYaml(meta: PlanMeta): string {
  const lines = [
    `title: ${JSON.stringify(meta.title || "")}`,
    `status: ${meta.status || "planning"}`,
    `phase: ${meta.phase || "proposal"}`,
    `owner: ${JSON.stringify(meta.owner || "")}`,
    ...(meta.sessionId ? [`session_id: ${JSON.stringify(meta.sessionId)}`] : []),
  ];
  return `${lines.join("\n")}\n`;
}

// Create a new change folder with a plan.yaml. Returns the change-id. Idempotent
// on the folder (never overwrites an existing plan.yaml).
export async function createChange(cwd: string, title: string, owner?: string, sessionId?: string): Promise<{ changeId: string; created: boolean; path: string }> {
  const changeId = toChangeId(title);
  assertSafeChangeId(changeId);
  const dir = changeDir(cwd, changeId);
  const planYaml = join(dir, "plan.yaml");
  const path = `${HIVE_PLANS_DIR}/${changeId}`;
  return withFileMutationQueue(planYaml, async () => {
    if (existsSync(planYaml)) return { changeId, created: false, path };
    ensureDir(dir);
    writeFileSync(planYaml, renderPlanYaml({ title, owner, sessionId, status: "planning", phase: "proposal" }));
    return { changeId, created: true, path };
  });
}

export function readPlanMeta(cwd: string, changeId: string): PlanMeta {
  if (!isSafeChangeId(changeId)) return {};
  const raw = readIfSmall(join(changeDir(cwd, changeId), "plan.yaml"), 16_000);
  if (!raw) return {};
  try {
    const parsed = parseYamlLite(raw) as any;
    return {
      title: parsed?.title ? String(parsed.title) : undefined,
      status: parsed?.status ? String(parsed.status) : undefined,
      phase: parsed?.phase ? String(parsed.phase) : undefined,
      owner: parsed?.owner ? String(parsed.owner) : undefined,
      sessionId: parsed?.session_id ? String(parsed.session_id) : undefined,
    };
  } catch {
    return {};
  }
}

const NEXT_PHASE: Record<string, string> = {
  proposal: "requirements",
  requirements: "design",
  design: "tasks",
  tasks: "apply",
};

export async function approveGate(cwd: string, changeId: string, phase: string): Promise<PlanMeta> {
  assertSafeChangeId(changeId);
  const dir = changeDir(cwd, changeId);
  const planYaml = join(dir, "plan.yaml");
  return withFileMutationQueue(planYaml, async () => {
    if (!changeExists(cwd, changeId)) {
      throw new Error(`No change "${changeId}" under ${HIVE_PLANS_DIR}. Use plan_new to create it first.`);
    }
    const current = readPlanMeta(cwd, changeId);
    const expectedPhase = current.phase || "proposal";
    if (phase !== expectedPhase) {
      throw new Error(`Cannot approve "${phase}" gate while change "${changeId}" is waiting for "${expectedPhase}" approval.`);
    }
    const nextPhase = NEXT_PHASE[phase] || phase;
    const next: PlanMeta = {
      ...current,
      status: phase === "tasks" ? "ready" : "planning",
      phase: nextPhase,
    };
    writeFileSync(planYaml, renderPlanYaml(next));
    return next;
  });
}

export function isReadyToExecute(cwd: string, changeId: string): boolean {
  const meta = readPlanMeta(cwd, changeId);
  return meta.status === "ready" && (meta.phase === "apply" || meta.phase === "ready");
}

export function hasTasks(cwd: string, changeId: string): boolean {
  return isSafeChangeId(changeId) && existsSync(join(changeDir(cwd, changeId), "tasks.md"));
}

export function readTasks(cwd: string, changeId: string): string {
  return isSafeChangeId(changeId) ? safeRead(join(changeDir(cwd, changeId), "tasks.md")) : "";
}

// The artifact files present in a change folder (for dashboard/status display).
export function listArtifacts(cwd: string, changeId: string): string[] {
  try {
    if (!isSafeChangeId(changeId)) return [];
    return (readdirSync(changeDir(cwd, changeId), { withFileTypes: true }) as FsDirent[])
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

// Guard a requested artifact path so a dashboard read cannot traverse outside
// the change folder. Returns the resolved absolute path or null if unsafe.
export function resolveArtifact(cwd: string, changeId: string, relPath: string): string | null {
  if (!isSafeChangeId(changeId)) return null;
  const base = changeDir(cwd, changeId);
  const target = resolve(base, relPath);
  if (target !== base && !target.startsWith(`${base}/`)) return null;
  return target;
}

// Best-effort: extract the change title from its proposal.md first heading.
export function proposalTitle(cwd: string, changeId: string): string | undefined {
  if (!isSafeChangeId(changeId)) return undefined;
  const raw = readIfSmall(join(changeDir(cwd, changeId), "proposal.md"), 8_000);
  const heading = raw.split("\n").map((l) => l.trim()).find((l) => l.startsWith("# "));
  if (heading) return heading.replace(/^#\s+/, "").slice(0, 200);
  const { attrs } = parseFrontmatter(raw);
  return attrs?.title ? String(attrs.title) : undefined;
}
