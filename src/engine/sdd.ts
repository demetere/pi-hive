import type { HiveState, SddChangeStatus, SddStatus } from "../core/types";
import * as openspec from "./openspec";

// OpenSpec-backed status view for the hive. This module used to implement the
// in-house .pi/hive/plans/ SDD store; it is now a thin adapter over the OpenSpec
// CLI wrapper (src/engine/openspec.ts) that preserves the SddStatus/
// SddChangeStatus shape and the resolveHiveSddStatus / renderHiveSddStatus /
// renderSddPromptBlock surface so the TUI widget, dashboard, tools, and prompt
// injection keep working unchanged. OpenSpec is the store + validator; pi-hive
// owns orchestration and the approval gate.

// Human-readable next step for a change: the next unauthored ready artifact, or
// execution readiness once tasks are authored.
function changePhase(detail: openspec.ChangeDetail | null, summary: openspec.ChangeSummary): string {
  if (detail?.nextReady) return detail.nextReady;
  if (summary.status === "complete") return "ready";
  if (summary.totalTasks > 0) return `tasks (${summary.completedTasks}/${summary.totalTasks})`;
  return "tasks";
}

function activeChanges(cwd: string): SddChangeStatus[] {
  return openspec.listChanges(cwd).map((c) => {
    const detail = openspec.changeDetail(cwd, c.name);
    const files = openspec.listArtifacts(cwd, c.name).map((f) => f.replace(/\.md$/, ""));
    return {
      name: c.name,
      path: `openspec/changes/${c.name}`,
      files,
      nextPhase: changePhase(detail, c),
      summary: c.totalTasks > 0 ? `${c.completedTasks}/${c.totalTasks} tasks complete` : "No tasks authored yet.",
    };
  });
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
  const available = openspec.isAvailable();
  const initialized = available && openspec.isInitialized(cwd);
  const planning = findAgent(state, [/planning/i, /product/i, /requirement/i, /spec/i, /plan/i]);
  const engineering = findAgent(state, [/engineering/i, /backend/i, /frontend/i, /implementation/i, /apply/i, /coder/i]);
  const validation = findAgent(state, [/validation/i, /qa/i, /test/i, /security/i, /verify/i, /review/i]);
  const suggestedRouting = [
    planning ? `proposal/design/specs/tasks → ${planning}` : "proposal/design/specs/tasks → Planning lead not detected",
    engineering ? `apply/implementation → ${engineering}` : "apply/implementation → Engineering lead not detected",
    validation ? `review verdict → ${validation}` : "review verdict → Validation lead not detected",
    "final synthesis → Orchestrator coordinates confirmation and durable updates",
  ];
  return {
    configured: initialized,
    configPath: initialized ? "openspec/" : available ? undefined : "openspec CLI not installed",
    activeChanges: initialized ? activeChanges(cwd) : [],
    suggestedRouting,
  };
}

export function renderHiveSddStatus(status: SddStatus): string {
  const lines = [
    "# OpenSpec plan store status",
    "",
    `Plan store present: ${status.configured ? "yes" : "no"}${status.configPath ? ` (${status.configPath})` : ""}`,
    "",
    "## Suggested hive routing",
    ...status.suggestedRouting.map((line) => `- ${line}`),
    "",
    "## Active changes",
  ];
  if (!status.activeChanges.length) {
    lines.push(status.configured ? "No active changes under openspec/changes/." : "OpenSpec not initialized for this project.");
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
        "proposal/design/specs/tasks → Planning lead",
        "apply/implementation → Engineering lead",
        "review verdict → Validation lead",
        "final synthesis → Orchestrator coordinates confirmation and durable updates",
      ];
  const activeChanges = status?.activeChanges?.length
    ? status.activeChanges.map((change) => `- ${change.name}: next=${change.nextPhase}, path=${change.path}`).join("\n")
    : "- none";
  const bootstrap = status?.configured
    ? "OpenSpec is initialized; keep using openspec/changes/<change-id>/ artifacts as the source of truth."
    : "OpenSpec is not initialized yet; for the first non-trivial change, run /opsx-propose to scaffold openspec/changes/<change-id>/ (proposal → design/specs → tasks) before implementation.";

  return `## Default workflow: spec-driven planning on OpenSpec\nUse spec-driven development as the default hive operating mode for non-trivial work. Do not let substantial work live only in chat. Keep proposal, design, specs, and tasks in file-backed artifacts under openspec/changes/<change-id>/, authored via the /opsx-* commands OpenSpec installs. Spec deltas must live at specs/<capability>/spec.md inside the change; <capability> is a domain/capability slug, not the change-id repeated. Do not create a bare spec.md or specs/spec.md — OpenSpec validation discovers capability folders.\n\n${bootstrap}\n\nSuggested phase ownership:\n${suggestedRouting.map((line) => `- ${line}`).join("\n")}\n\nActive changes:\n${activeChanges}\n\nDefault phase flow:\n- proposal → design → specs → tasks: Planning clarifies scope, technical design, spec deltas, and the ordered task plan. When scope or requirements are ambiguous, interrogate the user with ask_user BEFORE writing artifacts.\n- review: each finished artifact is reviewed in the dashboard's plan-review UI; approving the tasks artifact opens the execution gate.\n- apply/implementation: Engineering (coders/testers) makes the changes once the tasks gate is approved.\n- verify + final synthesis: Validation reviews and the Orchestrator coordinates confirmation and durable updates.\n\nUse hive_sdd_status for current artifact status; run /hive-execute <change-id> to drive execution from an approved, validated tasks.md. Tiny direct answers can stay inline, but code changes, cross-file investigations, ambiguous requests, or review-risky work should go through OpenSpec by default.`;
}
