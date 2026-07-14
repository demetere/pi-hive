import type { AgentType, PlanStage } from "../core/types";
import type { FileClass } from "./file-class";
import { toPosixPath } from "./glob";
import { artifactIdFromReference } from "../shared/openspec-artifacts";

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

// Resolve only canonical OpenSpec change artifacts. Generic design.md/tasks.md
// files elsewhere are docs/tasks, not planning gates. Every markdown file below
// specs/ belongs to the single aggregate `specs` stage.
function gateOf(pathRelativeToCwd: string): PlanStage | null {
  const rel = toPosixPath(pathRelativeToCwd).replace(/^\.\//, "");
  const match = rel.match(/(?:^|\/)openspec\/changes\/[a-z0-9]+(?:-[a-z0-9]+)*\/(.+)$/);
  return match ? artifactIdFromReference(match[1]) : null;
}

// Narrow which canonical artifact paths a planner may write. `stages` omitted
// means all four artifacts. Files outside openspec/changes are unaffected by
// stage ownership (the normal type + domain policies still apply).
export function checkPlannerStages(stages: PlanStage[] | undefined, pathRelativeToCwd: string): PolicyDecision {
  if (!stages) return OK;
  const gate = gateOf(pathRelativeToCwd);
  if (gate === null) return OK;
  if (stages.includes(gate)) return OK;
  return {
    ok: false,
    reason: `Blocked: this planner owns stages [${stages.join(", ")}] and may not write the "${gate}" artifact (${toPosixPath(pathRelativeToCwd)}).`,
  };
}
