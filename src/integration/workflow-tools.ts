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

export function genericWorkflowToolsForNode(snapshot: ActivationSnapshotFileV1, nodeId: string): readonly ToolDefinition<any, object>[] {
  const enabled = new Set(genericWorkflowToolContractsForNode(snapshot, nodeId).map((contract) => contract.name));
  return Object.freeze(GENERIC_WORKFLOW_TOOL_DEFINITIONS.filter((tool) => enabled.has(tool.name)));
}
