import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActivationSnapshotFileV1 } from "../../src/config/snapshot.ts";
import {
  GENERIC_WORKFLOW_TOOL_DEFINITIONS,
  genericWorkflowToolsForNode,
} from "../../src/integration/workflow-tools.ts";
import { GENERIC_WORKFLOW_TOOL_CONTRACTS } from "../../src/workflows/tools.ts";

test("Pi workflow tool adapter preserves core schemas and handlers", () => {
  assert.deepEqual(
    GENERIC_WORKFLOW_TOOL_DEFINITIONS.map((tool) => tool.name),
    GENERIC_WORKFLOW_TOOL_CONTRACTS.map((contract) => contract.name),
  );
  for (const [index, definition] of GENERIC_WORKFLOW_TOOL_DEFINITIONS.entries()) {
    const contract = GENERIC_WORKFLOW_TOOL_CONTRACTS[index];
    assert.equal(definition.parameters, contract.parameters);
    assert.equal(definition.execute, contract.execute);
  }
});

test("Pi workflow tool adapter filters definitions through core authority contracts", () => {
  const snapshot = {
    payload: {
      authority: {
        nodes: [{ nodeId: "worker", tools: ["route_agent", "team_status"] }],
      },
    },
  } as unknown as ActivationSnapshotFileV1;

  assert.deepEqual(
    genericWorkflowToolsForNode(snapshot, "worker").map((tool) => tool.name),
    ["route_agent", "team_status"],
  );
  assert.throws(() => genericWorkflowToolsForNode(snapshot, "missing"), /absent from immutable authority/i);
});
