import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { BODY_CATEGORIES } from "../core/mental-model";
import type { AgentRuntime, DomainScope, KnowledgeRef, HiveState } from "../core/types";
import { readIfSmall } from "../core/utils";
import { renderSkillRegistryMenu } from "../engine/skill-registry";
import { renderSddPromptBlock } from "../engine/sdd";

export function buildSharedContext(state: HiveState, ctx: ExtensionContext): string {
  if (!state.config) return "";
  const blocks: string[] = [];
  for (const relative of state.config.sharedContext || []) {
    const fullPath = resolve(ctx.cwd, relative);
    const content = readIfSmall(fullPath);
    if (content) blocks.push(`## ${relative}\n${content}`);
  }
  return blocks.join("\n\n---\n\n");
}

// Context = always-injected knowledge (mental model, AGENTS.md, architecture
// docs, always-on behaviors). Full content is inlined into the prompt.
export function renderKnowledgeRefs(ctx: ExtensionContext, title: string, refs: KnowledgeRef[] | undefined): string {
  if (!refs?.length) return `## ${title}\nNo configured ${title.toLowerCase()}.`;
  const blocks = refs.map((ref) => {
    const fullPath = resolve(ctx.cwd, ref.path);
    const content = readIfSmall(fullPath, 96_000);
    const body = content || `[not readable: ${ref.path}]`;
    const meta = [
      ref.useWhen ? `use when: ${ref.useWhen}` : undefined,
      ref.updatable ? "this is your durable mental model; it is curated automatically after your run" : undefined,
    ].filter(Boolean).join("; ");
    return `### ${ref.path}${meta ? `\n_${meta}_` : ""}\n${body}`;
  });
  return `## ${title}\n${blocks.join("\n\n")}`;
}

// Skills = on-demand procedures. Only a menu (name + use-when) is injected; the
// agent pulls full content with the load_skill tool when a skill applies.
export function skillName(ref: KnowledgeRef): string {
  return ref.path.replace(/^.*\//, "").replace(/\.[^.]+$/, "");
}

export function renderSkillMenu(refs: KnowledgeRef[] | undefined): string {
  if (!refs?.length) return "## Skills\nNo skills configured.";
  const rows = refs.map((ref) => `- ${skillName(ref)}: ${ref.useWhen || "use when relevant to the task"}`);
  return `## Skills (call load_skill with the skill name to read the full instructions)\nLoad a skill before doing work it applies to. Read any "always" skills first.\n${rows.join("\n")}`;
}

export function renderDomainScopes(scopes: DomainScope[] | undefined): string {
  if (!scopes?.length) return "## Domain boundaries\nNo domains are configured, so file tools (read/edit/write/bash on paths) are all blocked for you. Work through delegation or report what you would need access to.";
  const rows = scopes.map((scope) => {
    const flags = [
      scope.read ? "read" : undefined,
      scope.upsert ? "upsert" : undefined,
      scope.delete ? "delete" : undefined,
    ].filter(Boolean).join("/") || "no access";
    return `- ${scope.path} — ${flags}${scope.description ? ` — ${scope.description}` : ""}`;
  });
  return `## Domain boundaries\n${rows.join("\n")}\n\nThese scopes are ENFORCED at the tool layer: read/edit/write/bash calls on paths outside your domains are blocked. Treat them as hard limits — if a task needs access you do not have, say so in your answer instead of attempting it.`;
}

export function buildOrchestratorPrompt(state: HiveState, ctx: ExtensionContext): string {
  if (!state.config) return "";
  const runtime = state.runtimes.get(state.config.orchestrator.name.toLowerCase());
  if (!runtime) return "";
  const responsibilities = runtime.config.responsibilities?.length ? runtime.config.responsibilities.map((item) => `- ${item}`).join("\n") : "- Route work to the team leads and synthesize results.";
  const context = renderKnowledgeRefs(ctx, "Orchestrator context and mental model", runtime.config.context);
  const skills = renderSkillMenu(runtime.config.skills);
  const discoveredSkills = renderSkillRegistryMenu(state);
  const sdd = renderSddPromptBlock(state);
  const domain = renderDomainScopes(runtime.config.domain);
  const leadRoster = state.config.agents
    .map((agent) => `- ${agent.name}: ${agent.consultWhen || agent.routingTags?.join(", ") || "team work"}`)
    .join("\n");

  return `${runtime.systemPrompt}

## Active orchestrator contract
You are running as the visible top-level Pi session. You are not a normal coding agent with direct file tools. Your job is to route, delegate, monitor, and synthesize.

## Responsibilities
${responsibilities}

${domain}

${context}

${skills}

${discoveredSkills}

${sdd ? `${sdd}\n\n` : ""}## Chain of command
You delegate ONLY to the team leads below. Each lead owns its team and fans work
out to its own members — you never delegate to a member directly. Pick the team
whose lead best fits the request; the lead decides who under them does the work.

### Team leads (your only delegation targets)
${leadRoster}

## Mandatory routing behavior
- If the user asks you to read, inspect, analyze, compare, or find gaps in files, immediately delegate to the right team lead. Do not say you cannot read it; use delegate_agent on a lead.
- Backend/frontend/architecture/testing work → Engineering Lead. Requirements, scope, product, or UX → Planning Lead. Verification, QA, security, or release confidence → Validation Lead.
- If the user says "plan", "plan first", "spec", "approach", or "don't implement yet", delegate to Planning Lead first and stop for user confirmation before execution.
- After implementation-oriented findings, delegate to Validation Lead when evidence, QA, or security confidence matters.
- For cross-cutting work, delegate to multiple leads (up to the parallel limit) and let each fan out within its team.
- Synthesize the leads' results into one answer with evidence, risks, and next steps.`;
}

export function buildWorkerPrompt(state: HiveState, ctx: ExtensionContext, runtime: AgentRuntime, task: string): string {
  const group = runtime.config.groupName ? `Group: ${runtime.config.groupName}` : "Group: Orchestration";
  const sharedContext = buildSharedContext(state, ctx);
  const routingTags = runtime.config.routingTags?.length ? runtime.config.routingTags.join(", ") : "none";
  const responsibilities = runtime.config.responsibilities?.length ? runtime.config.responsibilities.map((item) => `- ${item}`).join("\n") : "- Use your role prompt and the assigned task.";
  const reports = runtime.config.allowedAgents || [];
  const delegationScope = runtime.config.allowedAgents === undefined
    ? "No explicit nested delegation scope configured."
    : reports.length
      ? `You lead a team. Your direct reports are: ${reports.join(", ")}. When a task should reach them (e.g. it asks you to fan work out, propagate something downstream, or it needs their specialist judgment), you MUST actually call delegate_agent for each relevant report and wait for their real answers — do NOT describe, assume, or fabricate what they would say. Only answer directly for work that is genuinely yours alone and does not involve your reports. Then synthesize their actual responses into your final answer.`
      : "You have no reports; you cannot delegate. Do the work yourself and, if a task needs another agent, say so in your answer for your lead to route.";
  const knowledgeContext = renderKnowledgeRefs(ctx, "Context and mental model", runtime.config.context);
  const skills = renderSkillMenu(runtime.config.skills);
  const discoveredSkills = renderSkillRegistryMenu(state, 25);
  const sdd = renderSddPromptBlock(state);
  const domain = renderDomainScopes(runtime.config.domain);

  return `${runtime.systemPrompt}

## Hive operating context
${group}
Agent: ${runtime.config.name}
Consult when: ${runtime.config.consultWhen || "Any task matching your role"}
Routing tags: ${routingTags}
Nested delegation: ${delegationScope}

## Responsibilities
${responsibilities}

You are one participant in a larger team. The orchestrator may synthesize your answer with other agents.
Be direct, evidence-backed, and explicit about uncertainty. Do not claim changes were made unless you actually made them.

${domain}

${knowledgeContext}

${skills}

${discoveredSkills}

${sdd ? `${sdd}\n\n` : ""}## Shared project context
${sharedContext || "No shared context files were readable."}

## Cross-agent context
Your task below carries the context your lead judged relevant. If you need more — e.g. exactly what a reviewer found — call team_conversation with that agent's name (e.g. team_conversation(agent: "Security Reviewer")) to read its own transcript. Do not assume you can see other agents' work otherwise.

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
