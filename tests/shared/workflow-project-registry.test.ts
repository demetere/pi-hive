import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listRegisteredWorkflowProjects, registerWorkflowProject, workflowProjectRegistryPath, workflowProjectRoots } from "../../src/shared/workflow-project-registry";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-hive-project-registry-"));
  const agentDir = join(root, "agent"); const first = join(root, "first"); const second = join(root, "second");
  mkdirSync(first); mkdirSync(second); process.env.PI_CODING_AGENT_DIR = agentDir;
  return { root, agentDir, first, second };
}

test("workflow project registry atomically retains multiple canonical project roots", () => {
  const previous = process.env.PI_CODING_AGENT_DIR; const { first, second } = fixture();
  try {
    const one = registerWorkflowProject(first, "2026-01-01T00:00:00.000Z");
    const two = registerWorkflowProject(second, "2026-01-01T00:00:01.000Z");
    const refreshed = registerWorkflowProject(first, "2026-01-01T00:00:02.000Z");
    assert.equal(refreshed.projectId, one.projectId);
    assert.deepEqual(listRegisteredWorkflowProjects().map((entry) => entry.projectId), [one.projectId, two.projectId].sort());
    assert.equal(listRegisteredWorkflowProjects().find((entry) => entry.projectId === one.projectId)?.registeredAt, "2026-01-01T00:00:02.000Z");
    assert.deepEqual(workflowProjectRoots(), [one.projectRoot, two.projectRoot].sort());
    assert.equal(statSync(workflowProjectRegistryPath()).mode & 0o777, 0o600);
  } finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; }
});

test("workflow project registry refuses corrupt or over-trusting persisted identities", () => {
  const previous = process.env.PI_CODING_AGENT_DIR; const { agentDir, first } = fixture();
  try {
    mkdirSync(join(agentDir, "hive"), { recursive: true, mode: 0o700 });
    writeFileSync(workflowProjectRegistryPath(), JSON.stringify({ formatVersion: 1, projects: [{ projectId: "not-a-hash", projectRoot: first, projectLabel: "First", registeredAt: "2026-01-01T00:00:00.000Z" }] }), { mode: 0o600 });
    chmodSync(workflowProjectRegistryPath(), 0o600);
    assert.throws(() => listRegisteredWorkflowProjects(), /identity/i);
    assert.match(readFileSync(workflowProjectRegistryPath(), "utf8"), /not-a-hash/u, "corrupt state is preserved rather than silently replaced");
  } finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; }
});
