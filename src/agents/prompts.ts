import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HiveState } from "../core/types";
import { renderDomainScopes, renderKnowledgeRefs, renderSkillMenu } from "../core/prompting";
import { renderSkillRegistryMenu } from "../engine/skill-registry";
import { renderSddPromptBlock } from "../engine/sdd";

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
