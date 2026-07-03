import type { AgentRuntime, HiveState } from "../core/types";
import { agentMatches, agentSlug } from "../core/utils";

export function runtimeKey(runtime: AgentRuntime): string {
  return agentSlug(runtime.config);
}

export function resolveRuntime(state: HiveState, id: string | undefined): AgentRuntime | undefined {
  const raw = String(id || "").trim();
  if (!raw) return undefined;
  const bySlug = state.runtimes.get(raw.toLowerCase());
  if (bySlug) return bySlug;
  for (const runtime of state.runtimes.values()) {
    if (agentMatches(runtime.config, raw)) return runtime;
  }
  if (raw === "Orchestrator" && state.config?.orchestrator) {
    return resolveRuntime(state, agentSlug(state.config.orchestrator));
  }
  return undefined;
}

export function agentRef(runtime: AgentRuntime): string {
  return agentSlug(runtime.config);
}

export function agentRoster(state: HiveState): string {
  return Array.from(state.runtimes.values())
    .map((runtime) => `${agentSlug(runtime.config)} (${runtime.config.name})`)
    .join(", ") || "none";
}
