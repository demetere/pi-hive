import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { HiveState } from "../core/types";
import { enforceDomainForTool } from "./domain";

// Worker AgentSessions are created with customTools, which bypass the
// extension/hook system entirely (ToolDefinition has no interception point).
// Domain enforcement only runs through pi.on("tool_call", ...), so each worker
// needs this one hook re-attached via its own resourceLoader — otherwise a
// worker's read/write/edit/bash calls would silently skip domain scoping.
// DefaultResourceLoader resolves cwd/agentDir eagerly in its constructor, so
// both must be passed even though this loader registers no other resources.
export function workerResourceLoader(state: HiveState, cwd: string, _callerName: string, skillPaths: string[] = []): DefaultResourceLoader {
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
      },
    ],
  });
}
