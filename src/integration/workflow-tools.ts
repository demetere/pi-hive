import { defineTool as definePiTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ActivationSnapshotFileV1 } from "../config/snapshot";
import {
  GENERIC_WORKFLOW_TOOL_CONTRACTS,
  genericWorkflowToolContractsForNode,
} from "../workflows/tools";

function adaptTool<T extends ToolDefinition<any, object>>(contract: T): T {
  return definePiTool(contract) as T;
}

export const GENERIC_WORKFLOW_TOOL_DEFINITIONS: readonly ToolDefinition<any, object>[] = Object.freeze(
  GENERIC_WORKFLOW_TOOL_CONTRACTS.map((contract) => adaptTool(contract)),
);

export interface WorkflowRootToolRuntime {
  runWithToolRuntime<T>(callback: () => T): T;
}

/**
 * Production root tools execute inside the selected run's trusted async-local
 * binding. Merely registering a public tool with the same name never grants
 * authority: every invocation re-resolves the currently linked session.
 */
export function workflowToolDefinitionsWithRuntime(resolve: () => WorkflowRootToolRuntime | undefined): readonly ToolDefinition<any, object>[] {
  return Object.freeze(GENERIC_WORKFLOW_TOOL_DEFINITIONS.map((definition) => adaptTool({
    ...definition,
    execute: (...args: Parameters<typeof definition.execute>) => {
      const runtime = resolve();
      if (!runtime) throw new Error("Workflow tool execution requires a selected schema-v1 run");
      return runtime.runWithToolRuntime(() => definition.execute(...args));
    },
  })));
}

export function genericWorkflowToolsForNode(snapshot: ActivationSnapshotFileV1, nodeId: string): readonly ToolDefinition<any, object>[] {
  const enabled = new Set(genericWorkflowToolContractsForNode(snapshot, nodeId).map((contract) => contract.name));
  return Object.freeze(GENERIC_WORKFLOW_TOOL_DEFINITIONS.filter((tool) => enabled.has(tool.name)));
}
