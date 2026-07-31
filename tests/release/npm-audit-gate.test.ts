import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  AUDIT_EXCEPTION_EXPIRES,
  readAuditEvidenceFromLock,
  validateAuditReport,
} from "../../scripts/check-npm-audit.mjs";

const acceptedNode = "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion";

function advisory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 1123898,
    name: "brace-expansion",
    dependency: "brace-expansion",
    title: "brace-expansion denial of service",
    url: "https://github.com/advisories/GHSA-3jxr-9vmj-r5cp",
    severity: "high",
    range: ">=3.0.0 <5.0.7",
    ...overrides,
  };
}

function vulnerability(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "brace-expansion",
    severity: "high",
    isDirect: false,
    via: [advisory()],
    effects: [],
    range: "3.0.0 - 5.0.6",
    nodes: [acceptedNode],
    fixAvailable: true,
    ...overrides,
  };
}

function report(vulnerabilities: Record<string, unknown>): unknown {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const value of Object.values(vulnerabilities)) {
    const severity = (value as Record<string, unknown>).severity;
    if (typeof severity === "string" && severity in counts && severity !== "total") {
      counts[severity as keyof Omit<typeof counts, "total">] += 1;
    }
    counts.total += 1;
  }
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: counts,
      dependencies: { prod: 1, dev: 1, optional: 0, peer: 0, peerOptional: 0, total: 2 },
    },
  };
}

const exactEvidence = {
  now: new Date("2026-07-20T12:00:00Z"),
  braceExpansionVersion: "5.0.6",
  piCodingAgentVersion: "0.80.7",
};

test("accepts only the exact temporary brace-expansion advisory", () => {
  const result = validateAuditReport(report({ "brace-expansion": vulnerability() }), exactEvidence);
  assert.equal(result.acceptedAdvisory, "GHSA-3jxr-9vmj-r5cp");
  assert.equal(result.expires, AUDIT_EXCEPTION_EXPIRES);
  assert.ok(result.warning);
  assert.match(result.warning, /GHSA-3jxr-9vmj-r5cp/);
  assert.match(result.warning, new RegExp(AUDIT_EXCEPTION_EXPIRES));
});

test("rejects every unrelated high or critical vulnerability", () => {
  for (const severity of ["high", "critical"]) {
    assert.throws(
      () => validateAuditReport(report({ unsafe: vulnerability({ name: "unsafe", severity, via: [advisory({ name: "unsafe", severity })] }) }), exactEvidence),
      new RegExp(severity),
    );
  }
});

test("fails closed when exception identity, path, or installed versions drift", () => {
  const cases: Array<[string, unknown, typeof exactEvidence]> = [
    ["advisory URL", report({ "brace-expansion": vulnerability({ via: [advisory({ url: "https://example.invalid/advisory" })] }) }), exactEvidence],
    ["advisory source", report({ "brace-expansion": vulnerability({ via: [advisory({ source: 1123899 })] }) }), exactEvidence],
    ["node path", report({ "brace-expansion": vulnerability({ nodes: ["node_modules/brace-expansion"] }) }), exactEvidence],
    ["extra affected node", report({ "brace-expansion": vulnerability({ nodes: [acceptedNode, "node_modules/brace-expansion"] }) }), exactEvidence],
    ["brace-expansion version", report({ "brace-expansion": vulnerability() }), { ...exactEvidence, braceExpansionVersion: "5.0.7" }],
    ["Pi version", report({ "brace-expansion": vulnerability() }), { ...exactEvidence, piCodingAgentVersion: "0.80.8" }],
  ];

  for (const [label, input, evidence] of cases) {
    assert.throws(() => validateAuditReport(input, evidence), Error, label);
  }
});

test("fails closed on malformed npm audit output", () => {
  for (const malformed of [null, {}, { auditReportVersion: 2, vulnerabilities: [] }, { auditReportVersion: 1, vulnerabilities: {} }]) {
    assert.throws(() => validateAuditReport(malformed, exactEvidence));
  }
});

test("fails closed once the temporary exception expires", () => {
  assert.throws(
    () => validateAuditReport(report({ "brace-expansion": vulnerability() }), { ...exactEvidence, now: new Date(`${AUDIT_EXCEPTION_EXPIRES}T00:00:00Z`) }),
    /expired/i,
  );
});

test("retains audit-level=high behavior for moderate-only reports without requiring exception evidence", () => {
  const moderate = vulnerability({
    name: "moderate-package",
    severity: "moderate",
    via: [advisory({ name: "moderate-package", severity: "moderate" })],
    nodes: ["node_modules/moderate-package"],
  });
  const result = validateAuditReport(report({ "moderate-package": moderate }), {
    now: new Date("2027-01-01T00:00:00Z"),
    braceExpansionVersion: "5.0.7",
    piCodingAgentVersion: "0.81.0",
  });
  assert.equal(result.acceptedAdvisory, null);
  assert.equal(result.warning, null);
});

test("loads lock evidence lazily only when the exact exception is present", () => {
  let calls = 0;
  const evidence = () => { calls += 1; return exactEvidence; };
  validateAuditReport(report({}), evidence);
  assert.equal(calls, 0);
  validateAuditReport(report({ "brace-expansion": vulnerability() }), evidence);
  assert.equal(calls, 1);
});

test("derives exact version evidence from the committed lock without node_modules", () => {
  const evidence = readAuditEvidenceFromLock({
    lockfileVersion: 3,
    packages: {
      "node_modules/@earendil-works/pi-coding-agent": { version: "0.80.7" },
      [acceptedNode]: { version: "5.0.6" },
    },
  });
  assert.deepEqual(evidence, { braceExpansionVersion: "5.0.6", piCodingAgentVersion: "0.80.7" });

  for (const malformed of [null, {}, { lockfileVersion: 3, packages: {} }]) {
    assert.throws(() => readAuditEvidenceFromLock(malformed), /lock/i);
  }
});

test("root CI uses the targeted checker while dashboard audit remains unchanged", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /name: Audit root dependencies\s+run: node scripts\/check-npm-audit\.mjs/);
  assert.match(workflow, /name: Audit dashboard dependencies\s+run: npm audit --prefix ui\/web --audit-level=high/);
});
