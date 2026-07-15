import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { auditAgentTypes } from "../src/core/agent-type-audit.ts";

function fixture(config: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-agent-audit-"));
  mkdirSync(join(cwd, ".pi", "hive", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "hive", "hive-config.yaml"), config);
  return cwd;
}

test("agent-type audit tolerates absent and non-object configurations", () => {
  const missing = mkdtempSync(join(tmpdir(), "pi-hive-agent-audit-missing-"));
  assert.deepEqual(auditAgentTypes(missing), { rows: [], offenders: [] });
  assert.deepEqual(auditAgentTypes(fixture("null\n")), { rows: [], offenders: [] });
  assert.deepEqual(auditAgentTypes(fixture("planning: text\nhive: false\n")), { rows: [], offenders: [] });
});

test("agent-type audit walks legacy, explicit, nested, duplicate, and sparse nodes", () => {
  const cwd = fixture(`
main:
  name: Shared Lead
  path: .pi/hive/agents/shared.md
agents:
  - name: Direct Coder
    path: .pi/hive/agents/direct.md
    agentType: coder
    members:
      - name: Frontmatter Reviewer
        path: .pi/hive/agents/reviewer.md
      - ignored
    children:
      - path: .pi/hive/agents/empty.md
      - name: Escaping
        path: ../outside.md
planning:
  orchestrator:
    name: Shared Lead
    path: .pi/hive/agents/shared.md
  agents: not-an-array
`);
  writeFileSync(join(cwd, ".pi", "hive", "agents", "shared.md"), "---\nagent-type: lead\n---\nLead");
  writeFileSync(join(cwd, ".pi", "hive", "agents", "reviewer.md"), "---\nagent-type: reviewer\n---\nReview");
  writeFileSync(join(cwd, ".pi", "hive", "agents", "empty.md"), "");

  const audit = auditAgentTypes(cwd);
  assert.equal(audit.rows.filter((row) => row.name === "Shared Lead").length, 1);
  assert.equal(audit.rows.find((row) => row.name === "Direct Coder")?.declared, "coder");
  assert.equal(audit.rows.find((row) => row.name === "Frontmatter Reviewer")?.declared, "reviewer");
  assert.ok(audit.rows.some((row) => row.name === "(unnamed)"));
  assert.ok(audit.rows.some((row) => row.name === "Escaping" && !row.valid));
  assert.ok(audit.offenders.length >= 2);
});

test("explicit hive block accepts orchestrator aliases and missing paths", () => {
  const cwd = fixture(`
hive:
  orchestrator:
    name: Inline Lead
    agentType: lead
  agents:
    - name: No Path Coder
      agentType: coder
    - name: Missing File
      path: .pi/hive/agents/missing.md
`);
  const audit = auditAgentTypes(cwd);
  assert.equal(audit.rows.find((row) => row.name === "Inline Lead")?.valid, true);
  assert.equal(audit.rows.find((row) => row.name === "No Path Coder")?.valid, true);
  assert.equal(audit.rows.find((row) => row.name === "Missing File")?.declared, undefined);
});
