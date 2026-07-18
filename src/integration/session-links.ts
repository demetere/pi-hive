import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SessionNavigationAdapter } from "../workflows/navigation";

export const WORKFLOW_SESSION_MARKER_TYPE = "pi-hive-workflow-link-v1";

/**
 * Bind the pure workflow navigation service to Pi's replacement-session API.
 * Only plain identifiers are captured across replacement; all session-bound work
 * runs against the fresh context supplied to withSession.
 */
export function createPiSessionNavigationAdapter(commandContext: ExtensionCommandContext): SessionNavigationAdapter {
  return {
    async create(input) {
      let created: { piSessionId: string; piSessionFile: string } | undefined;
      const result = await commandContext.newSession({
        parentSession: input.parentSession,
        setup: async (manager) => {
          manager.appendSessionInfo(input.name);
          manager.appendCustomEntry(WORKFLOW_SESSION_MARKER_TYPE, {
            formatVersion: 1,
            workflowId: input.workflowId,
            activationHash: input.activationHash,
          });
        },
        withSession: async (fresh) => {
          const file = fresh.sessionManager.getSessionFile();
          if (!file) throw new Error("Workflow Pi session is not persisted");
          created = { piSessionId: fresh.sessionManager.getSessionId(), piSessionFile: file };
        },
      });
      if (result.cancelled || !created) throw new Error("Workflow Pi session creation cancelled");
      return created;
    },
    async switch(input) {
      return commandContext.switchSession(input.piSessionFile, {
        withSession: async (fresh) => input.withSession(fresh),
      });
    },
  };
}
