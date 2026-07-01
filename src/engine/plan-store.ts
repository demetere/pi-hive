import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HIVE_PLANS_DIR } from "../core/constants";
import { ensureDir, readIfSmall, safeRead, slug } from "../core/utils";
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
}

export function plansRoot(cwd: string): string {
  return resolve(cwd, HIVE_PLANS_DIR);
}

export function changeDir(cwd: string, changeId: string): string {
  return join(plansRoot(cwd), changeId);
}

export function changeExists(cwd: string, changeId: string): boolean {
  return existsSync(changeDir(cwd, changeId));
}

export function listChangeIds(cwd: string): string[] {
  try {
    return (readdirSync(plansRoot(cwd), { withFileTypes: true }) as FsDirent[])
      .filter((entry) => entry.isDirectory() && entry.name !== "archive")
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

// Normalize a user-supplied title/id into a stable kebab change-id.
export function toChangeId(input: string): string {
  return slug(input);
}

function renderPlanYaml(meta: PlanMeta): string {
  const lines = [
    `title: ${JSON.stringify(meta.title || "")}`,
    `status: ${meta.status || "planning"}`,
    `phase: ${meta.phase || "proposal"}`,
    `owner: ${JSON.stringify(meta.owner || "")}`,
  ];
  return `${lines.join("\n")}\n`;
}

// Create a new change folder with a plan.yaml. Returns the change-id. Idempotent
// on the folder (never overwrites an existing plan.yaml).
export function createChange(cwd: string, title: string, owner?: string): { changeId: string; created: boolean; path: string } {
  const changeId = toChangeId(title);
  const dir = changeDir(cwd, changeId);
  const planYaml = join(dir, "plan.yaml");
  const path = `${HIVE_PLANS_DIR}/${changeId}`;
  if (existsSync(planYaml)) return { changeId, created: false, path };
  ensureDir(dir);
  writeFileSync(planYaml, renderPlanYaml({ title, owner, status: "planning", phase: "proposal" }));
  return { changeId, created: true, path };
}

export function readPlanMeta(cwd: string, changeId: string): PlanMeta {
  const raw = readIfSmall(join(changeDir(cwd, changeId), "plan.yaml"), 16_000);
  if (!raw) return {};
  try {
    const parsed = parseYamlLite(raw) as any;
    return {
      title: parsed?.title ? String(parsed.title) : undefined,
      status: parsed?.status ? String(parsed.status) : undefined,
      phase: parsed?.phase ? String(parsed.phase) : undefined,
      owner: parsed?.owner ? String(parsed.owner) : undefined,
    };
  } catch {
    return {};
  }
}

export function hasTasks(cwd: string, changeId: string): boolean {
  return existsSync(join(changeDir(cwd, changeId), "tasks.md"));
}

export function readTasks(cwd: string, changeId: string): string {
  return safeRead(join(changeDir(cwd, changeId), "tasks.md"));
}

// The artifact files present in a change folder (for dashboard/status display).
export function listArtifacts(cwd: string, changeId: string): string[] {
  try {
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
  const base = changeDir(cwd, changeId);
  const target = resolve(base, relPath);
  if (target !== base && !target.startsWith(`${base}/`)) return null;
  return target;
}

// Best-effort: extract the change title from its proposal.md first heading.
export function proposalTitle(cwd: string, changeId: string): string | undefined {
  const raw = readIfSmall(join(changeDir(cwd, changeId), "proposal.md"), 8_000);
  const heading = raw.split("\n").map((l) => l.trim()).find((l) => l.startsWith("# "));
  if (heading) return heading.replace(/^#\s+/, "").slice(0, 200);
  const { attrs } = parseFrontmatter(raw);
  return attrs?.title ? String(attrs.title) : undefined;
}
