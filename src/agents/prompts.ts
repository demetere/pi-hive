import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HiveState } from "../core/types";
import { renderKnowledgeRefs } from "../core/prompting";
import { renderSddPromptBlock } from "../engine/sdd";
import { resolveRuntime } from "../engine/agent-lookup";
import { agentSlug } from "../core/utils";

export function buildOrchestratorPrompt(state: HiveState, ctx: ExtensionContext): string {
  if (!state.config) return "";
  const runtime = resolveRuntime(state, state.config.orchestrator.slug || state.config.orchestrator.name);
  if (!runtime) return "";
  const responsibilities = runtime.config.responsibilities?.length ? runtime.config.responsibilities.map((item) => `- ${item}`).join("\n") : "- Route work to the team leads and synthesize results.";
  const context = renderKnowledgeRefs(ctx, "Orchestrator context and mental model", runtime.config.context);
  const sdd = renderSddPromptBlock(state);
  // Phase 5.2: the main session has NO enforceable file tools, so do not render
  // the worker-style "these scopes are ENFORCED at the tool layer" block for it —
  // that language is false here (there is nothing to enforce against). Just note
  // that any configured domain is advisory context for what the team owns.
  const domain = runtime.config.domain?.length
    ? `## Domain context\nThe team's file domains are enforced on the WORKERS you delegate to, not on you (you have no direct file tools). Route work to the lead whose domain covers it.`
    : "";
  const leadRoster = state.config.agents
    .map((agent) => `- ${agentSlug(agent)} — ${agent.name}: ${agent.consultWhen || agent.routingTags?.join(", ") || "team work"}`)
    .join("\n");
  // H3/Decision 8: build the mandatory-routing guidance from the ACTUAL
  // configured leads (their consultWhen / routing tags), not hardcoded example
  // names. A team with custom lead names gets a correct routing prompt.
  const routingGuidance = state.config.agents
    .map((agent) => {
      const cue = agent.consultWhen || agent.routingTags?.join(", ") || "its area of work";
      return `- Work matching "${cue}" → ${agentSlug(agent)} (${agent.name}).`;
    })
    .join("\n");

  return `${runtime.systemPrompt}

## Active orchestrator contract
You are running as the visible top-level Pi session. You are not a normal coding agent with direct file tools. Your job is to route, delegate, monitor, and synthesize.

## Responsibilities
${responsibilities}

${domain}

${context}

${sdd ? `${sdd}\n\n` : ""}## Chain of command
You delegate ONLY to the team leads below. Each lead owns its team and fans work
out to its own members — you never delegate to a member directly. Pick the team
whose lead best fits the request; the lead decides who under them does the work.

### Team leads (your only delegation targets)
${leadRoster}

## Mandatory routing behavior
- If the user asks you to read, inspect, analyze, compare, or find gaps in files, immediately delegate to the right team lead. Do not say you cannot read it; call delegate_agent with BOTH required fields exactly like {"agent":"<lead name>","task":"<focused task, paths, and expected output>"}. Never call delegate_agent with empty arguments.
${routingGuidance}
- If the user says "plan", "plan first", "spec", "approach", or "don't implement yet", switch to plan mode (or delegate to the planning lead) first and stop for user confirmation before execution.
- For cross-cutting work, delegate to multiple leads (up to the parallel limit) and let each fan out within its team.
- Use team_status when deciding whether to resume a lead's existing session or call delegate_agent with fresh=true; context around 75% means consider fresh when continuity is not needed, and around 85% means prefer fresh unless continuity is essential.
- Synthesize the leads' results into one answer with evidence, risks, and next steps.`;
}
