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
      let enteredReplacement = false;
      const restore = async (): Promise<void> => {
        if (!input.restoreSession) throw new Error("Pi replacement session has no restoration target");
        const restored = await commandContext.switchSession(input.restoreSession, { withSession: async () => {} });
        if (restored.cancelled) throw new Error("Pi replacement session restoration was cancelled");
      };
      try {
        const result = await commandContext.newSession({
          parentSession: input.parentSession,
          setup: async (manager) => {
            manager.appendSessionInfo(input.name);
            manager.appendCustomEntry(WORKFLOW_SESSION_MARKER_TYPE, {
              formatVersion: 1,
              workflowId: input.workflowId,
              activationHash: input.activationHash,
              ...(input.recovery ? { recovery: input.recovery } : {}),
            });
          },
          withSession: async (fresh) => {
            enteredReplacement = true;
            const file = fresh.sessionManager.getSessionFile();
            if (!file) throw new Error("Workflow Pi session is not persisted");
            created = { piSessionId: fresh.sessionManager.getSessionId(), piSessionFile: file };
          },
        });
        if (result.cancelled || !created) throw new Error("Workflow Pi session creation cancelled");
      } catch (error) {
        if (enteredReplacement && input.restoreSession) {
          try { await restore(); }
          catch (restoreError) { throw new AggregateError([error, restoreError], "Workflow Pi session creation failed and restoration was unsuccessful"); }
        }
        throw error;
      }
      return { ...created, ...(input.restoreSession ? { compensate: restore } : {}) };
    },
    async switch(input) {
      return commandContext.switchSession(input.piSessionFile, {
        withSession: async (fresh) => input.withSession(fresh),
      });
    },
  };
}
