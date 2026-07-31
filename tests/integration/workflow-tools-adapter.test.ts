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

test("every Pi generic tool exposes a callable top-level object schema", () => {
  const expectedRequired = new Map<string, readonly string[]>([
    ["route_agent", ["objective"]],
    ["delegate_agent", ["targetNodeId", "objective", "deliverables"]],
    ["team_status", []],
    ["workflow_status", []],
    ["artifact_status", []],
    ["artifact_action", ["actionId", "arguments"]],
    ["knowledge_search", ["query"]],
    ["knowledge_read", ["bundleId", "documentId"]],
    ["knowledge_propose", ["scope", "conclusion", "evidenceEventIds"]],
    ["human_question", ["prompt", "kind", "required"]],
    ["workflow_finish", ["status", "summary"]],
  ]);

  assert.equal(expectedRequired.size, GENERIC_WORKFLOW_TOOL_DEFINITIONS.length);
  for (const definition of GENERIC_WORKFLOW_TOOL_DEFINITIONS) {
    const schema = definition.parameters as unknown as Record<string, unknown>;
    assert.equal(schema.type, "object", `${definition.name} must project as a callable object`);
    assert.equal("anyOf" in schema, false, `${definition.name} must not use a root anyOf`);
    assert.equal("oneOf" in schema, false, `${definition.name} must not use a root oneOf`);
    assert.ok(schema.properties && typeof schema.properties === "object", `${definition.name} must expose visible properties`);
    assert.deepEqual(schema.required ?? [], expectedRequired.get(definition.name), `${definition.name} must expose its required fields`);
  }

  const teamStatus = GENERIC_WORKFLOW_TOOL_DEFINITIONS.find((tool) => tool.name === "team_status")!;
  const teamProperties = (teamStatus.parameters as unknown as { properties: Record<string, unknown> }).properties;
  assert.deepEqual(Object.keys(teamProperties), ["action", "deliveryId", "limit", "cursor"]);

  const humanQuestion = GENERIC_WORKFLOW_TOOL_DEFINITIONS.find((tool) => tool.name === "human_question")!;
  const questionProperties = (humanQuestion.parameters as unknown as { properties: Record<string, unknown> }).properties;
  assert.deepEqual(Object.keys(questionProperties), ["prompt", "kind", "choices", "validation", "required"]);
  assert.deepEqual((questionProperties.kind as { enum?: readonly string[] }).enum, ["single", "multi", "text", "confirm"]);
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
