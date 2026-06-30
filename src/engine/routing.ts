import type { HiveState } from "../core/types";
import { currentAgentName } from "./session";
import { canDelegateTo } from "./domain";

export function routeAgents(state: HiveState, task: string, limit = 5): Array<{ name: string; group: string; score: number; reasons: string[] }> {
  const terms = task.toLowerCase().split(/[^a-z0-9_-]+/).filter((term) => term.length > 2);
  const caller = currentAgentName();
  const scored = Array.from(state.runtimes.values())
    .filter((runtime) => runtime.config.role !== "orchestrator")
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
      if (/security|auth|permission|tenant|secret|injection|data exposure/i.test(task) && runtime.config.name === "Security Reviewer") {
        score += 10;
        reasons.push("security-sensitive");
      }
      if (/test|qa|verify|regression|evidence|acceptance/i.test(task) && runtime.config.name === "QA Engineer") {
        score += 8;
        reasons.push("verification");
      }
      if (/frontend|react|ui|component|hook|css|locale|accessibility/i.test(task) && runtime.config.name === "Frontend Dev") {
        score += 8;
        reasons.push("frontend");
      }
      if (/backend|api|service|database|migration|worker|fastapi|schema/i.test(task) && runtime.config.name === "Backend Dev") {
        score += 8;
        reasons.push("backend");
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
