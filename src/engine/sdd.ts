import { existsSync, readdirSync } from "node:fs";

type FsDirent = { name: string; isDirectory(): boolean };
import { join, relative } from "node:path";
import type { HiveState, SddChangeStatus, SddStatus } from "../core/types";
import { readIfSmall } from "../core/utils";
import { HIVE_PLANS_DIR } from "../core/constants";

// The planning gates plus execution-evidence files, in order. The first missing
// file is the "next phase". Only the four GATES are shown as the derived phase
// list; apply-progress / verify-report are execution status detail, not gates.
const PHASE_FILES: Array<{ file: string; phase: string }> = [
  { file: "proposal.md", phase: "proposal" },
  { file: "requirements.md", phase: "requirements" },
  { file: "design.md", phase: "design" },
  { file: "tasks.md", phase: "tasks" },
  { file: "apply-progress.md", phase: "apply" },
  { file: "verify-report.md", phase: "verify" },
];

// The four planning gates the dashboard renders as the workflow phase list.
export const PLAN_GATES = ["proposal", "requirements", "design", "tasks"] as const;

// Resolve the plan-store root: prefer .pi/hive/plans/, fall back to OpenSpec's
// openspec/changes/ if the hive store is absent (nice-to-have back-compat).
function planStoreRoot(cwd: string): { root: string; kind: "hive" | "openspec" } {
  const hive = join(cwd, ".pi", "hive", "plans");
  if (existsSync(hive)) return { root: hive, kind: "hive" };
  const openspec = join(cwd, "openspec", "changes");
  if (existsSync(openspec)) return { root: openspec, kind: "openspec" };
  return { root: hive, kind: "hive" };
}

function phasePresent(changeDir: string, file: string): boolean {
  return existsSync(join(changeDir, file));
}

function nextPhase(changeDir: string): string {
  for (const phase of PHASE_FILES) {
    if (!phasePresent(changeDir, phase.file)) return phase.phase;
  }
  return "ready";
}

function changeSummary(changeDir: string): string {
  for (const file of ["proposal.md", "requirements.md", "design.md", "tasks.md", "apply-progress.md", "verify-report.md"]) {
    const text = readIfSmall(join(changeDir, file), 32_000);
    const first = text.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("#"));
    if (first) return first.slice(0, 240);
  }
  return "No summary found yet.";
}

function activeChanges(cwd: string): SddChangeStatus[] {
  const { root } = planStoreRoot(cwd);
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
  const { root, kind } = planStoreRoot(cwd);
  const configured = existsSync(root);
  const planning = findAgent(state, [/planning/i, /product/i, /requirement/i, /spec/i, /plan/i]);
  const engineering = findAgent(state, [/engineering/i, /backend/i, /frontend/i, /implementation/i, /apply/i, /coder/i]);
  const validation = findAgent(state, [/validation/i, /qa/i, /test/i, /security/i, /verify/i, /review/i]);
  const suggestedRouting = [
    planning ? `proposal/requirements/design/tasks → ${planning}` : "proposal/requirements/design/tasks → Planning lead not detected",
    engineering ? `apply-progress/implementation → ${engineering}` : "apply-progress/implementation → Engineering lead not detected",
    validation ? `verify-report/review verdict → ${validation}` : "verify-report/review verdict → Validation lead not detected",
    "final synthesis → Orchestrator coordinates confirmation and durable updates",
  ];
  return {
    configured,
    configPath: configured ? relative(cwd, root) : (kind === "hive" ? HIVE_PLANS_DIR : undefined),
    activeChanges: activeChanges(cwd),
    suggestedRouting,
  };
}

export function renderHiveSddStatus(status: SddStatus): string {
  const lines = [
    "# Hive plan store status",
    "",
    `Plan store present: ${status.configured ? "yes" : "no"}${status.configPath ? ` (${status.configPath})` : ""}`,
    "",
    "## Suggested hive routing",
    ...status.suggestedRouting.map((line) => `- ${line}`),
    "",
    "## Active changes",
  ];
  if (!status.activeChanges.length) {
    lines.push(status.configured ? `No active changes found under ${status.configPath || HIVE_PLANS_DIR}/.` : `No plan store found yet (${HIVE_PLANS_DIR}/).`);
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
        "proposal/requirements/design/tasks → Planning lead",
        "apply-progress/implementation → Engineering lead",
        "verify-report/review verdict → Validation lead",
        "final synthesis → Orchestrator coordinates confirmation and durable updates",
      ];
  const activeChanges = status?.activeChanges?.length
    ? status.activeChanges.map((change) => `- ${change.name}: next=${change.nextPhase}, path=${change.path}`).join("\n")
    : "- none";
  const bootstrap = status?.configured
    ? `A plan store is present; keep using ${HIVE_PLANS_DIR}/<change-id>/ artifacts as the source of truth.`
    : `No plan store yet; for the first non-trivial change, route Planning to create a ${HIVE_PLANS_DIR}/<change-id>/ folder (proposal → requirements → design → tasks) before implementation.`;

  return `## Default workflow: spec-driven planning\nUse spec-driven development as the default hive operating mode for non-trivial work. Do not let substantial work live only in chat. Keep requirements, design, tasks, implementation evidence, and verification evidence in file-backed artifacts under ${HIVE_PLANS_DIR}/<change-id>/.\n\n${bootstrap}\n\nSuggested phase ownership:\n${suggestedRouting.map((line) => `- ${line}`).join("\n")}\n\nActive changes:\n${activeChanges}\n\nDefault phase flow:\n- proposal → requirements → design → tasks: Planning clarifies scope, user requirements/acceptance criteria, technical design, and the ordered task plan (one approval gate at a time).\n- apply-progress/implementation: Engineering (coders/testers) makes the changes and records files touched plus evidence.\n- verify-report/review verdict: Validation (reviewers) checks tests, regressions, and submits a structured verdict.\n- final synthesis: Orchestrator coordinates confirmation when risk is high and durable updates.\n\nUse hive_sdd_status for current artifact status; run /hive-execute <change-id> to drive execution from an approved tasks.md. Tiny direct answers can stay inline, but code changes, cross-file investigations, ambiguous requests, or review-risky work should go through the plan store by default.`;
}
