import type { AgentType, PlanStage } from "../core/types";
import type { FileClass } from "./file-class";
import { toPosixPath } from "./glob";

// Actions the type-policy layer reasons about. `read`/`upsert`/`delete` carry a
// file class; `command` (non-mutating bash), `verdict`, and `commit` do not
// (fileClass is null). `commit` is gated by the agent's `commit:` config field
// in domain.ts, not by this matrix, so it always passes here.
export type PolicyAction = "read" | "upsert" | "delete" | "command" | "verdict" | "commit";

export interface PolicyDecision {
  ok: boolean;
  reason?: string;
}

const OK: PolicyDecision = { ok: true };

// Human-readable "what this type may write" clause for denial messages.
const WRITABLE_CLASSES: Record<AgentType, FileClass[]> = {
  planner: ["spec", "docs", "tasks"],
  coder: ["code", "docs", "tasks"],
  tester: ["code", "docs", "tasks"],
  reviewer: [],
  lead: [],
};

const WRITE_SUMMARY: Record<AgentType, string> = {
  planner: "Planners write spec/docs/tasks only.",
  coder: "Coders write code/docs/tasks, not spec files.",
  tester: "Testers write code/docs/tasks (tests within their domain), not spec files.",
  reviewer: "Reviewers are read-only and may only submit verdicts.",
  lead: "Leads delegate and coordinate; they do not modify files.",
};

function denyWrite(agentType: AgentType, fileClass: FileClass, action: "upsert" | "delete"): PolicyDecision {
  return {
    ok: false,
    reason: `Blocked: agent-type "${agentType}" may not ${action} ${fileClass} files. ${WRITE_SUMMARY[agentType]}`,
  };
}

// The (agentType, fileClass, action) capability matrix as a pure function —
// no I/O, unit-testable in isolation. Implements §4 of the spec. Returns
// {ok:true} when allowed, {ok:false, reason} when the TYPE forbids the action.
// Both this AND the domain-glob boundary must pass for a mutation to proceed.
export function checkTypePolicy(agentType: AgentType, fileClass: FileClass | null, action: PolicyAction): PolicyDecision {
  switch (action) {
    case "read":
      // Every type may read anything within its domain (domain globs still gate paths).
      return OK;
    case "command":
    case "commit":
      // Non-mutating commands and commit are gated elsewhere (commit by the
      // `commit:` config field), never by the type matrix.
      return OK;
    case "verdict":
      // Only reviewers may submit verdicts. Enforced structurally too (the tool
      // is registered reviewer-only), but kept here as defense in depth.
      return agentType === "reviewer" ? OK : { ok: false, reason: `Blocked: agent-type "${agentType}" may not submit review verdicts. Only reviewers can.` };
    case "upsert":
    case "delete": {
      // A mutation with no resolvable path/class is denied for read-only types
      // and allowed for mutators (the domain layer decides the path).
      const writable = WRITABLE_CLASSES[agentType];
      if (writable.length === 0) {
        return { ok: false, reason: `Blocked: agent-type "${agentType}" may not ${action} files. ${WRITE_SUMMARY[agentType]}` };
      }
      if (fileClass === null) return OK; // pathless mutating bash — domain layer will still require in-domain paths
      return writable.includes(fileClass) ? OK : denyWrite(agentType, fileClass, action);
    }
    default:
      return OK;
  }
}

// Map a gate artifact filename to its PlanStage. Only the four gate files are
// stage-scoped; any other spec file (e.g. under specs/) returns null and is
// allowed for any planner.
const GATE_FILES: Record<string, PlanStage> = {
  "proposal.md": "proposal",
  "requirements.md": "requirements",
  "design.md": "design",
  "tasks.md": "tasks",
};

function gateOf(pathRelativeToCwd: string): PlanStage | null {
  const base = toPosixPath(pathRelativeToCwd).split("/").pop() || "";
  return GATE_FILES[base] ?? null;
}

// Narrow which gate artifacts a planner may write. `stages` omitted = all four
// gates allowed. A gate file whose stage is not in `stages` is blocked; non-gate
// spec files are allowed for any planner. Only meaningful for planners writing
// spec/tasks-class files — call after checkTypePolicy has allowed the write.
export function checkPlannerStages(stages: PlanStage[] | undefined, pathRelativeToCwd: string): PolicyDecision {
  if (!stages) return OK; // omitted ⇒ all gates
  const gate = gateOf(pathRelativeToCwd);
  if (gate === null) return OK; // non-gate spec artifact ⇒ any planner may write
  if (stages.includes(gate)) return OK;
  return {
    ok: false,
    reason: `Blocked: this planner owns gates [${stages.join(", ")}] and may not write the "${gate}" gate (${toPosixPath(pathRelativeToCwd).split("/").pop()}).`,
  };
}
