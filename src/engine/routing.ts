import type { HiveState } from "../core/types";
import { currentAgentName } from "./session";
import { canDelegateTo } from "./domain";

export function routeAgents(state: HiveState, task: string, limit = 5): Array<{ name: string; group: string; score: number; reasons: string[] }> {
  const terms = task.toLowerCase().split(/[^a-z0-9_-]+/).filter((term) => term.length > 2);
  const caller = currentAgentName();
  const scored = Array.from(state.runtimes.values())
    .filter((runtime) => runtime.config.role !== "orchestrator")
    // Plan mode routing surfaces planners, leads, and reviewers (Phase 5.1) —
    // mirrors the dispatch guard; reviewers are delegable in planning (read-only).
    .filter((runtime) => state.mode !== "plan" || ["planner", "lead", "reviewer"].includes(runtime.config.agentType || ""))
    .filter((runtime) => canDelegateTo(state, caller, runtime.config.name).ok)
    .map((runtime) => {
      const searchableParts = [
        runtime.config.name,
        runtime.config.groupName || "",
        runtime.config.consultWhen || "",
        ...(runtime.config.routingTags || []),
        ...(runtime.config.responsibilities || []),
        ...(runtime.config.domain || []).map((domain) => `${domain.path} ${domain.description || ""}`),
      ];
      const searchable = searchableParts.join(" ").toLowerCase();
      const reasons: string[] = [];
      let score = 0;

      for (const tag of runtime.config.routingTags || []) {
        const tagLower = tag.toLowerCase();
        if (task.toLowerCase().includes(tagLower)) {
          score += 8;
          reasons.push(`tag:${tag}`);
        }
      }
      for (const term of terms) {
        if (runtime.config.name.toLowerCase().includes(term)) score += 6;
        if (runtime.config.groupName?.toLowerCase().includes(term)) score += 4;
        if (searchable.includes(term)) score += 1;
      }
      // H3/Decision 8: no literal-name scoring bonuses. Routing scores by the
      // agent's declared routingTags, name/group term overlap, and agentType —
      // all above — so any team routes correctly regardless of how its agents
      // are named. Group-based SDD-phase heuristics below stay (they key off the
      // configured group name, not a hardcoded agent name).
      const at = runtime.config.agentType;
      if (at === "reviewer" && /security|auth|permission|tenant|secret|injection|data exposure|review/i.test(task)) {
        score += 4;
        reasons.push("reviewer-type");
      }
      if (at === "tester" && /test|qa|verify|regression|evidence|acceptance/i.test(task)) {
        score += 4;
        reasons.push("tester-type");
      }
      if (at === "coder" && /implement|code|refactor|fix|build|component|api|service|migration|schema/i.test(task)) {
        score += 3;
        reasons.push("coder-type");
      }
      if (/plan|scope|requirement|product|ux|acceptance|proposal|spec|design|tasks|openspec|sdd/i.test(task) && /planning/i.test(runtime.config.groupName || runtime.config.name)) {
        score += 4;
        reasons.push("planning-group");
      }
      if (/apply-progress|implementation|implement|code change/i.test(task) && /engineering/i.test(runtime.config.groupName || runtime.config.name)) {
        score += 4;
        reasons.push("sdd-apply");
      }
      if (/verify-report|verification|release confidence/i.test(task) && /validation|qa/i.test(runtime.config.groupName || runtime.config.name)) {
        score += 4;
        reasons.push("sdd-verify");
      }
      return { name: runtime.config.name, group: runtime.config.groupName || "", score, reasons: Array.from(new Set(reasons)).slice(0, 5) };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  return scored.slice(0, limit);
}
