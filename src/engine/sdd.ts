import { existsSync, readdirSync } from "node:fs";

type FsDirent = { name: string; isDirectory(): boolean };
import { join, relative } from "node:path";
import type { HiveState, SddChangeStatus, SddStatus } from "../core/types";
import { readIfSmall } from "../core/utils";

const PHASE_FILES: Array<{ file: string; phase: string }> = [
  { file: "proposal.md", phase: "proposal" },
  { file: "specs", phase: "spec" },
  { file: "design.md", phase: "design" },
  { file: "tasks.md", phase: "tasks" },
  { file: "apply-progress.md", phase: "apply" },
  { file: "verify-report.md", phase: "verify" },
  { file: "sync-report.md", phase: "sync" },
];

function dirHasFiles(path: string): boolean {
  try { return readdirSync(path).some(Boolean); } catch { return false; }
}

function phasePresent(changeDir: string, file: string): boolean {
  const full = join(changeDir, file);
  if (file === "specs") return existsSync(full) && dirHasFiles(full);
  return existsSync(full);
}

function nextPhase(changeDir: string): string {
  for (const phase of PHASE_FILES) {
    if (!phasePresent(changeDir, phase.file)) return phase.phase;
  }
  return "archive";
}

function changeSummary(changeDir: string): string {
  for (const file of ["proposal.md", "design.md", "tasks.md", "apply-progress.md", "verify-report.md", "sync-report.md"]) {
    const text = readIfSmall(join(changeDir, file), 32_000);
    const first = text.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("#"));
    if (first) return first.slice(0, 240);
  }
  return "No summary found yet.";
}

function activeChanges(cwd: string): SddChangeStatus[] {
  const root = join(cwd, "openspec", "changes");
  let entries: FsDirent[] = [];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((entry: FsDirent) => entry.isDirectory() && entry.name !== "archive")
    .map((entry: FsDirent) => {
      const dir = join(root, entry.name);
      const files = PHASE_FILES.filter((phase) => phasePresent(dir, phase.file)).map((phase) => phase.phase);
      return {
        name: entry.name,
        path: relative(cwd, dir),
        files,
        nextPhase: nextPhase(dir),
        summary: changeSummary(dir),
      };
    })
    .sort((a: SddChangeStatus, b: SddChangeStatus) => a.name.localeCompare(b.name));
}

function findAgent(state: HiveState, patterns: RegExp[]): string | undefined {
  const runtimes = Array.from(state.runtimes.values()).filter((runtime) => runtime.config.role !== "orchestrator");
  const scored = runtimes
    .map((runtime) => {
      const text = [
        runtime.config.name,
        runtime.config.groupName || "",
        runtime.config.consultWhen || "",
        ...(runtime.config.routingTags || []),
        ...(runtime.config.responsibilities || []),
      ].join(" ");
      const score = patterns.reduce((sum, pattern) => sum + (pattern.test(text) ? 1 : 0), 0);
      return { name: runtime.config.name, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored[0]?.name;
}

export function resolveHiveSddStatus(state: HiveState, cwd: string): SddStatus {
  const configPath = join(cwd, "openspec", "config.yaml");
  const configured = existsSync(configPath) || existsSync(join(cwd, "openspec"));
  const planning = findAgent(state, [/planning/i, /product/i, /requirement/i, /spec/i]);
  const engineering = findAgent(state, [/engineering/i, /backend/i, /frontend/i, /implementation/i, /apply/i]);
  const validation = findAgent(state, [/validation/i, /qa/i, /test/i, /security/i, /verify/i]);
  const suggestedRouting = [
    planning ? `proposal/spec/design/tasks → ${planning}` : "proposal/spec/design/tasks → Planning lead not detected",
    engineering ? `apply-progress/implementation → ${engineering}` : "apply-progress/implementation → Engineering lead not detected",
    validation ? `verify-report/release confidence → ${validation}` : "verify-report/release confidence → Validation lead not detected",
    "sync/archive → Orchestrator coordinates final synthesis and user confirmation",
  ];
  return {
    configured,
    configPath: configured ? relative(cwd, configPath) : undefined,
    activeChanges: activeChanges(cwd),
    suggestedRouting,
  };
}

export function renderHiveSddStatus(status: SddStatus): string {
  const lines = [
    "# Hive SDD/OpenSpec status",
    "",
    `OpenSpec configured: ${status.configured ? "yes" : "no"}${status.configPath ? ` (${status.configPath})` : ""}`,
    "",
    "## Suggested hive routing",
    ...status.suggestedRouting.map((line) => `- ${line}`),
    "",
    "## Active changes",
  ];
  if (!status.activeChanges.length) {
    lines.push(status.configured ? "No active changes found under openspec/changes/." : "No openspec/ directory found yet.");
  } else {
    for (const change of status.activeChanges) {
      lines.push(`- ${change.name}: next=${change.nextPhase}; artifacts=${change.files.join(", ") || "none"}; path=${change.path}`);
      if (change.summary) lines.push(`  - ${change.summary}`);
    }
  }
  return lines.join("\n");
}

export function renderSddPromptBlock(state: HiveState): string {
  const status = state.sddStatus;
  const suggestedRouting = status?.suggestedRouting?.length
    ? status.suggestedRouting
    : [
        "proposal/spec/design/tasks → Planning lead",
        "apply-progress/implementation → Engineering lead",
        "verify-report/release confidence → Validation lead",
        "sync/archive → Orchestrator coordinates final synthesis and user confirmation",
      ];
  const activeChanges = status?.activeChanges?.length
    ? status.activeChanges.map((change) => `- ${change.name}: next=${change.nextPhase}, path=${change.path}`).join("\n")
    : "- none";
  const bootstrap = status?.configured
    ? "OpenSpec is present; keep using openspec/changes/<change>/ artifacts as the source of truth."
    : "OpenSpec is not present yet; for the first non-trivial change, route Planning to create/initialize the openspec structure and a change folder before implementation.";

  return `## Default workflow: SDD/OpenSpec\nUse Spec-Driven Development as the default hive operating mode for non-trivial work. Do not let substantial work live only in chat. Keep requirements, design, tasks, implementation evidence, and verification evidence in file-backed OpenSpec-style artifacts.\n\n${bootstrap}\n\nSuggested phase ownership:\n${suggestedRouting.map((line) => `- ${line}`).join("\n")}\n\nActive changes:\n${activeChanges}\n\nDefault phase flow:\n- proposal/spec/design/tasks: Planning clarifies scope, requirements, non-goals, UX/product constraints, and the implementation plan.\n- apply-progress/implementation: Engineering makes the changes and records files touched plus evidence.\n- verify-report: Validation checks tests, regressions, security/QA concerns, and release confidence.\n- sync/archive: Orchestrator coordinates final synthesis, user confirmation when risk is high, and durable spec updates.\n\nUse hive_sdd_status when you need current artifact status. Tiny direct answers can stay inline, but code changes, cross-file investigations, ambiguous requests, or review-risky work should go through SDD by default.`;
}
