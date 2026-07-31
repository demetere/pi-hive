import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { resolveProjectIdentity } from "./project-identity";

const FORMAT_VERSION = 1 as const;
const MAX_PROJECTS = 256;
const MAX_FILE_BYTES = 1_048_576;

export interface RegisteredWorkflowProject {
  readonly projectId: string;
  readonly projectRoot: string;
  readonly projectLabel: string;
  readonly registeredAt: string;
}

interface RegistryFile {
  readonly formatVersion: typeof FORMAT_VERSION;
  readonly projects: readonly RegisteredWorkflowProject[];
}

export function workflowProjectRegistryPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "hive", "workflow-projects-v1.json");
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseRegistry(bytes: Buffer): readonly RegisteredWorkflowProject[] {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("Workflow project registry exceeds its byte limit");
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("Workflow project registry is invalid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Workflow project registry must be an object");
  const file = value as Partial<RegistryFile>;
  if (file.formatVersion !== FORMAT_VERSION || !Array.isArray(file.projects) || file.projects.length > MAX_PROJECTS) throw new Error("Workflow project registry format is unsupported or over capacity");
  const ids = new Set<string>(); const roots = new Set<string>(); const projects: RegisteredWorkflowProject[] = [];
  for (const entry of file.projects) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Workflow project registry entry is invalid");
    const candidate = entry as Partial<RegisteredWorkflowProject>;
    if (typeof candidate.projectId !== "string" || typeof candidate.projectRoot !== "string" || typeof candidate.projectLabel !== "string" || !validTimestamp(candidate.registeredAt)) throw new Error("Workflow project registry entry fields are invalid");
    if (!/^[0-9a-f]{64}$/u.test(candidate.projectId) || !isAbsolute(candidate.projectRoot) || candidate.projectRoot.includes("\0") || Buffer.byteLength(candidate.projectRoot, "utf8") > 4_096
      || !candidate.projectLabel || Buffer.byteLength(candidate.projectLabel, "utf8") > 512 || ids.has(candidate.projectId) || roots.has(candidate.projectRoot)) throw new Error("Workflow project registry identity is invalid or duplicated");
    ids.add(candidate.projectId); roots.add(candidate.projectRoot); projects.push(Object.freeze({ projectId: candidate.projectId, projectRoot: candidate.projectRoot, projectLabel: candidate.projectLabel, registeredAt: candidate.registeredAt }));
  }
  return Object.freeze(projects.sort((left, right) => left.projectId.localeCompare(right.projectId)));
}

export function listRegisteredWorkflowProjects(): readonly RegisteredWorkflowProject[] {
  const path = workflowProjectRegistryPath();
  if (!existsSync(path)) return Object.freeze([]);
  return parseRegistry(readFileSync(path));
}

function privateWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** Caller serializes registration with the daemon startup lock. */
export function registerWorkflowProject(projectRoot: string, registeredAt = new Date().toISOString()): RegisteredWorkflowProject {
  if (!validTimestamp(registeredAt)) throw new Error("Workflow project registration timestamp is invalid");
  const identity = resolveProjectIdentity(projectRoot);
  const entry = Object.freeze({ projectId: identity.projectId, projectRoot: identity.canonicalRoot, projectLabel: identity.displayLabel, registeredAt });
  const existing = listRegisteredWorkflowProjects().filter((project) => project.projectId !== entry.projectId);
  const projects = [...existing, entry].sort((left, right) => right.registeredAt.localeCompare(left.registeredAt) || left.projectId.localeCompare(right.projectId)).slice(0, MAX_PROJECTS).sort((left, right) => left.projectId.localeCompare(right.projectId));
  const serialized = `${JSON.stringify({ formatVersion: FORMAT_VERSION, projects })}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_FILE_BYTES) throw new Error("Workflow project registry exceeds its byte limit");
  privateWrite(workflowProjectRegistryPath(), serialized);
  return entry;
}

export function workflowProjectRoots(initialProjectRoot?: string): readonly string[] {
  const roots = listRegisteredWorkflowProjects().map((project) => project.projectRoot);
  if (initialProjectRoot) roots.push(resolveProjectIdentity(initialProjectRoot).canonicalRoot);
  return Object.freeze([...new Set(roots)].sort());
}
