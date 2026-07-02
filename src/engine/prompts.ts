import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BODY_CATEGORIES } from "../core/mental-model";
import type { AgentRuntime, HiveState, KnowledgeRef } from "../core/types";
import { buildSharedContext, renderDomainScopes, renderKnowledgeRefs } from "../core/prompting";

// The type-specific operating contract injected into a worker's prompt. States
// the capability boundary the enforcer also mechanically applies, so the model
// understands its role rather than only bouncing off tool denials. RED
// discipline is light: it states the tester/coder division but never mandates
// test-first ordering (ordering is the orchestrator's per-task choice).
export function buildOperatingContract(runtime: AgentRuntime): string {
  const type = runtime.config.agentType;
  if (!type) return "";
  const lines: string[] = ["## Operating contract (agent type)"];
  switch (type) {
    case "planner": {
      lines.push("You are a **planner**. You write only spec/requirements/design/tasks artifacts (under `.pi/hive/plans/`, plus docs). You must not modify production or test code — those edits are blocked at the tool layer.");
      if (runtime.config.stages?.length) lines.push(`You own these planning gates: ${runtime.config.stages.join(", ")}. You may write only those gate artifacts.`);
      break;
    }
    case "coder":
      lines.push("You are a **coder**. You implement production code and tests within your domain. You do not write spec files and you do not issue review verdicts. Tests are typically the tester's job.");
      break;
    case "tester":
      lines.push("You are a **tester**. You write tests, not production code. You do not write spec files or issue verdicts.");
      break;
    case "reviewer":
      lines.push("You are a **reviewer**. You are read-only: you may run inspection and test commands but must not modify files. Submit your final verdict with `submit_review_verdict` (red/yellow/green) — not as chat text.");
      break;
    case "lead": {
      lines.push("You are a **lead**. You delegate and coordinate; you do not modify files (all edits go through your coder/tester reports).");
      if (runtime.config.commit?.trim()) lines.push(`Commit guidance: ${runtime.config.commit.trim()} Never add AI attribution trailers to commit messages.`);
      break;
    }
  }
  // Interpreter limitation (G1): file mutations run through a general-purpose
  // interpreter (node -e, python -c, sh script.sh, npm run …) cannot be
  // statically classified by the bash policy, so the domain/commit guards do NOT
  // see them. Do not use interpreters to route around your write boundary — stay
  // within your domain via edit/write and the named shell commands the policy
  // recognizes. This is an explicit trust boundary, not a loophole.
  if (type === "coder" || type === "tester") {
    lines.push("Note: file changes made *through* an interpreter (`node -e`, `python -c`, `sh script.sh`, `npm run …`) are not visible to the domain enforcer. Do not use them to write outside your domain — use edit/write, which are enforced.");
  }
  return lines.join("\n");
}

export function buildWorkerPrompt(state: HiveState, ctx: ExtensionContext, runtime: AgentRuntime, task: string): string {
  // A worker's prompt is deliberately scoped to identity + boundaries + task.
  // Routing guidance (routing-tags / consult-when) is for the router, not the
  // worker (route_agent reads those off config); the plan-store/SDD workflow
  // lecture is the main session's concern; peer-transcript reading pollutes
  // context — the lead is responsible for passing everything the worker needs.
  const group = runtime.config.groupName ? `Group: ${runtime.config.groupName}` : "Group: Orchestration";
  const sharedContext = buildSharedContext(state, ctx);
  const responsibilities = runtime.config.responsibilities?.length ? runtime.config.responsibilities.map((item) => `- ${item}`).join("\n") : "- Use your role prompt and the assigned task.";
  const reports = runtime.config.allowedAgents || [];
  // Only leads (agents with reports) get delegation guidance; a leaf worker has
  // no reports and needs no paragraph about them.
  const delegationScope = reports.length
    ? `\nNested delegation: You lead a team. Your direct reports are: ${reports.join(", ")}. When a task should reach them (e.g. it asks you to fan work out, propagate something downstream, or it needs their specialist judgment), you MUST actually call delegate_agent for each relevant report and wait for their real answers — do NOT describe, assume, or fabricate what they would say. Only answer directly for work that is genuinely yours alone and does not involve your reports. Then synthesize their actual responses into your final answer.`
    : "";
  const knowledgeContext = renderKnowledgeRefs(ctx, "Context and mental model", runtime.config.context);
  const domain = renderDomainScopes(runtime.config.domain);
  const operatingContract = buildOperatingContract(runtime);

  return `${runtime.systemPrompt}

## Hive operating context
${group}
Agent: ${runtime.config.name}${delegationScope}

## Responsibilities
${responsibilities}

You are one participant in a larger team. Your lead has passed you the context it judged relevant; work from your task and the context below.
Be direct, evidence-backed, and explicit about uncertainty. Do not claim changes were made unless you actually made them.

${operatingContract ? `${operatingContract}\n\n` : ""}${domain}

${knowledgeContext}

## Shared project context
${sharedContext || "No shared context files were readable."}

## Assigned task
${task}

## Response contract
Return concise markdown with:
- Findings
- Evidence / files inspected
- Risks or assumptions
- Recommended next action
- Durable lessons worth remembering (stable facts, conventions, risk patterns) — state them plainly; your mental model is curated automatically from this conversation.

Wrap your final deliverable in a single <final_answer>...</final_answer> block so the orchestrator can extract the authoritative result.`;
}

// ── Mental-model distiller prompt helpers ──────────────────────────────────────

export function agentMentalModelTarget(runtime: AgentRuntime): KnowledgeRef | undefined {
  return runtime.config.context?.find((ref) => ref.updatable);
}

export function buildDistillerPrompt(agentName: string, currentModel: string, conversation: string, today: string): string {
  const categories = BODY_CATEGORIES.map((c) => `  - ${c.name}: ${c.holds}`).join("\n");
  return `You are the memory distiller for the "${agentName}" agent. You are NOT doing the agent's task — you maintain its durable mental model: stable architecture facts, conventions, team dynamics, successful patterns, recurring risks, and open questions. It is durable memory, not a transcript.

You are given (1) the agent's current mental-model file and (2) an excerpt of the conversation the agent just finished. Decide whether anything durable was learned: a stable architecture fact, a convention, a recurring risk pattern, a confirmed decision, or a team dynamic.

## Required structure

The file is YAML with a HARD SPINE and a SOFT BODY.

The SPINE is mandatory and always shaped exactly like this:
\`\`\`yaml
metadata:
  owner: ${agentName}          # exactly this; never change it
  purpose: <one-line role of this file>
  updated: "${today}"
risk_patterns:                 # a NAMED MAP (may be {}); each value is {cue, mitigation}
  <short_risk_name>:
    cue: <observable signal the risk is present>
    mitigation: <what to do about it>
observations: []               # list of durable notes; may be []
open_questions: []             # list of unresolved questions; may be []
\`\`\`

The BODY holds role-specific knowledge. Route every body fact under ONE of these pinned top-level categories — reuse the name, shape the content underneath freely. Only invent a new top-level key if a fact fits NONE of these (rare):
${categories}

## Worked example

\`\`\`yaml
metadata:
  owner: ${agentName}
  purpose: "Durable architecture, conventions, risks, and useful paths for this role."
  updated: "${today}"
domain_map:
  api_layer:
    role: "FastAPI routes and schemas handle transport contracts."
    convention: "Business rules belong in services, not routes."
    key_file: "backend/src/api/AGENTS.md"
conventions:
  imports:
    rule: "Imports stay at module level. Use TYPE_CHECKING for circular type hints."
principles:
  - "Read relevant AGENTS.md before code inspection or edits."
risk_patterns:
  access_control:
    cue: "Frontend role restriction, org-scoped resource, admin/superadmin operation."
    mitigation: "Verify a backend route/service guard is present. Frontend-only checks are not security."
observations:
  - "Engineering work is safer when AGENTS.md files are read before code inspection."
open_questions:
  - "Should this subsystem get a narrower module-specific AGENTS.md?"
\`\`\`

Rules:
- Return the COMPLETE new contents of the mental-model file (valid YAML), not a diff.
- ALWAYS emit the full spine, correctly shaped. Keep \`metadata.owner\` = "${agentName}". Set \`metadata.updated\` to "${today}".
- Put each body fact under the pinned category that fits; do NOT invent a synonym for an existing category (e.g. use \`domain_map\`, not \`architecture\`/\`backend_overview\`; \`evaluation\`, not \`*_lens\`; \`principles\`, not \`*_principles\`).
- \`risk_patterns\` is a map keyed by a stable short name so risks can be updated in place — do not duplicate an existing risk under a new name.
- CONSOLIDATE: integrate new learnings into existing structure; rewrite stale entries; do not blindly append duplicates.
- Preserve existing valid content that is still accurate. Reference paths and key facts; do not paste whole files.
- Current-state phrasing only. No changelog wording ("renamed from", "formerly", "now").
- Do NOT include transcripts, transient build/test output, or one-off task details — store only durable conclusions.
- If nothing durable was learned, return the current file UNCHANGED (but still with a valid spine).
- Output ONLY the file contents inside a single <mental_model>...</mental_model> block. No commentary.

## Current mental-model file
${currentModel || "(empty)"}

## Conversation excerpt (just completed)
${conversation || "(none)"}`;
}

export function extractTagged(text: string, tag: string): string | null {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1].trim() : null;
}
