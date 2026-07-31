import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { toWorkflowTelemetryEvent } from "../../src/observability/events.ts";
import { WorkflowTelemetryProjection } from "../../src/observability/projection.ts";
import { syncWorkflowCatalog, WORKFLOW_CATALOG_SESSION_ID } from "../../src/workflows/catalog.ts";
import { readWorkflowJournal } from "../../src/workflows/journal.ts";
import { copyWorkflowFixture } from "../helpers/workflow-fixtures.ts";

test("workflow catalog deduplicates unchanged definitions and retains immutable semantic versions", () => {
  const fixture = copyWorkflowFixture("artifact-free-debug");
  try {
    const first = syncWorkflowCatalog(fixture.projectRoot, "project-catalog");
    assert.deepEqual(first, { discovered: 1, cataloged: 1, retired: 0, unchanged: 0 });
    assert.deepEqual(syncWorkflowCatalog(fixture.projectRoot, "project-catalog"), { discovered: 1, cataloged: 0, retired: 0, unchanged: 1 });

    const workflowPath = join(fixture.projectRoot, ".pi/hive/workflows/debug-chat.yaml");
    writeFileSync(workflowPath, `${readFileSync(workflowPath, "utf8")}\n# formatting-only change\n`);
    assert.deepEqual(syncWorkflowCatalog(fixture.projectRoot, "project-catalog"), { discovered: 1, cataloged: 0, retired: 0, unchanged: 1 });

    writeFileSync(workflowPath, readFileSync(workflowPath, "utf8").replace("Investigate defects, explain findings, and fix them when authorized.", "Investigate and repair verified defects."));
    assert.deepEqual(syncWorkflowCatalog(fixture.projectRoot, "project-catalog"), { discovered: 1, cataloged: 1, retired: 0, unchanged: 0 });

    const events = readWorkflowJournal(fixture.projectRoot, WORKFLOW_CATALOG_SESSION_ID);
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((event) => event.type), ["workflow.cataloged", "workflow.cataloged"]);
    assert.deepEqual(events.map((event) => (event.payload as { definitionVersion: number }).definitionVersion), [1, 2]);
    assert.notEqual((events[0].payload as { definitionHash: string }).definitionHash, (events[1].payload as { definitionHash: string }).definitionHash);

    const latest = events[1].payload as { topology: Array<{ nodeId: string; agentId: string; agentName?: string; model?: string; thinking?: string }> };
    assert.deepEqual(latest.topology, [{ nodeId: "root", agentId: "debugger", agentName: "Debugger", model: "inherit", thinking: "medium" }]);

    const projection = new WorkflowTelemetryProjection();
    for (const event of events) projection.ingest(toWorkflowTelemetryEvent(event, { projectRoot: fixture.projectRoot, projectLabel: "Catalog fixture" }));
    const row = projection.current().workflows[0];
    assert.equal(row.workflowId, "debug-chat");
    assert.equal(row.workflowConfigVersion, "2");
    assert.equal(row.status, "available");
    const metadata = (row.metadata as { catalog: { definitionVersion: number; topology: Array<{ model?: string; thinking?: string }> } }).catalog;
    assert.equal(metadata.definitionVersion, 2);
    assert.deepEqual(metadata.topology.map((node) => ({ model: node.model, thinking: node.thinking })), [{ model: "inherit", thinking: "medium" }]);
  } finally { fixture.cleanup(); }
});

test("workflow catalog marks removed definitions retired without inventing a new version", () => {
  const fixture = copyWorkflowFixture("artifact-free-debug");
  try {
    syncWorkflowCatalog(fixture.projectRoot, "project-catalog-retired");
    const manifestPath = join(fixture.projectRoot, ".pi/hive/hive-config.yaml");
    writeFileSync(manifestPath, readFileSync(manifestPath, "utf8").replace(/workflows:\n(?: {2}.+\n)+/u, "workflows: {}\n"));
    const result = syncWorkflowCatalog(fixture.projectRoot, "project-catalog-retired");
    assert.deepEqual(result, { discovered: 0, cataloged: 0, retired: 1, unchanged: 0 });
    const events = readWorkflowJournal(fixture.projectRoot, WORKFLOW_CATALOG_SESSION_ID);
    assert.equal(events.at(-1)?.type, "workflow.retired");
    assert.equal((events.at(-1)?.payload as { definitionVersion: number }).definitionVersion, 1);
    assert.equal((events.at(-1)?.payload as { status: string }).status, "retired");
  } finally { fixture.cleanup(); }
});
