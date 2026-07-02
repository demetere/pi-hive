import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { HiveState } from "../core/types";
import { enforceDomainForTool } from "./domain";
import { emitHiveEvent } from "./observability";

// Worker AgentSessions are created with customTools, which bypass the
// extension/hook system entirely (ToolDefinition has no interception point).
// Domain enforcement only runs through pi.on("tool_call", ...), so each worker
// needs this one hook re-attached via its own resourceLoader — otherwise a
// worker's read/write/edit/bash calls would silently skip domain scoping.
// DefaultResourceLoader resolves cwd/agentDir eagerly in its constructor, so
// both must be passed even though this loader registers no other resources.
//
// Item 13: the extension seam is also the ONLY place worker-side ExtensionAPI
// events (pi.on) are reachable — dispatch.ts's session.subscribe() sees only
// AgentSessionEvents, so provider back-pressure (after_provider_response) never
// surfaces for workers otherwise. Wire it here so a worker stalled on a 429/529
// has the same visible cause the orchestrator does. callerName tags the events
// with the worker's own identity.
export function workerResourceLoader(state: HiveState, cwd: string, callerName: string, skillPaths: string[] = []): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    noSkills: skillPaths.length === 0,
    additionalSkillPaths: skillPaths,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      (pi: any) => {
        pi.on("tool_call", async (event: any, ctx: any) => enforceDomainForTool(state, event, ctx));
        // Only non-2xx responses (429/529 rate-limit/overload), mirroring the
        // orchestrator handler — successes would flood one row per call.
        pi.on("after_provider_response", async (event: any) => {
          const status = Number(event?.status);
          if (!Number.isFinite(status) || (status >= 200 && status < 300)) return;
          const headers = event?.headers || {};
          const pick = (k: string) => headers[k] ?? headers[k.toLowerCase()];
          emitHiveEvent(state, "provider_response", {
            agent: callerName,
            status,
            retryAfter: pick("retry-after"),
            rateLimitRemaining: pick("anthropic-ratelimit-requests-remaining") ?? pick("x-ratelimit-remaining"),
          }, callerName);
        });
      },
    ],
  });
}
