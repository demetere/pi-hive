#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ADVISORY_ID = "GHSA-3jxr-9vmj-r5cp";
const ADVISORY_SOURCE = 1123898;
const ADVISORY_URL = `https://github.com/advisories/${ADVISORY_ID}`;
const PACKAGE_NAME = "brace-expansion";
const AFFECTED_NODE = "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion";
const BRACE_EXPANSION_VERSION = "5.0.6";
const PI_CODING_AGENT_VERSION = "0.80.7";
const EXPIRY_INSTANT = "2026-08-20T00:00:00Z";

export const AUDIT_EXCEPTION_EXPIRES = "2026-08-20";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message) {
  throw new Error(`npm audit gate failed closed: ${message}`);
}

function validateEvidence(evidence) {
  if (!isRecord(evidence) || !(evidence.now instanceof Date) || !Number.isFinite(evidence.now.getTime())) {
    fail("invalid date evidence");
  }
  if (evidence.now.getTime() >= Date.parse(EXPIRY_INSTANT)) {
    fail(`temporary exception expired on ${AUDIT_EXCEPTION_EXPIRES}`);
  }
  if (evidence.braceExpansionVersion !== BRACE_EXPANSION_VERSION) {
    fail(`installed brace-expansion version drifted from ${BRACE_EXPANSION_VERSION}`);
  }
  if (evidence.piCodingAgentVersion !== PI_CODING_AGENT_VERSION) {
    fail(`installed @earendil-works/pi-coding-agent version drifted from ${PI_CODING_AGENT_VERSION}`);
  }
}

function validateReportShape(report) {
  if (!isRecord(report) || report.auditReportVersion !== 2 || !isRecord(report.vulnerabilities)) {
    fail("malformed or unsupported npm audit JSON");
  }
  if (!isRecord(report.metadata) || !isRecord(report.metadata.vulnerabilities)) {
    fail("npm audit JSON is missing vulnerability metadata");
  }

  const severities = ["info", "low", "moderate", "high", "critical"];
  const reportedCounts = report.metadata.vulnerabilities;
  const actualCounts = Object.fromEntries(severities.map((severity) => [severity, 0]));
  for (const severity of [...severities, "total"]) {
    if (!Number.isInteger(reportedCounts[severity]) || reportedCounts[severity] < 0) {
      fail(`npm audit JSON has invalid ${severity} metadata`);
    }
  }

  for (const [key, value] of Object.entries(report.vulnerabilities)) {
    if (
      !isRecord(value)
      || typeof value.name !== "string"
      || !severities.includes(value.severity)
      || !Array.isArray(value.via)
      || !value.via.every((via) => typeof via === "string" || (isRecord(via) && severities.includes(via.severity)))
      || !Array.isArray(value.nodes)
      || !value.nodes.every((node) => typeof node === "string")
    ) {
      fail(`malformed vulnerability entry ${key}`);
    }
    actualCounts[value.severity] += 1;
  }

  for (const severity of severities) {
    if (reportedCounts[severity] !== actualCounts[severity]) {
      fail(`npm audit JSON ${severity} metadata does not match its vulnerability entries`);
    }
  }
  if (reportedCounts.total !== Object.keys(report.vulnerabilities).length) {
    fail("npm audit JSON total metadata does not match its vulnerability entries");
  }
}

function gateSeverity(vulnerability) {
  const severityRank = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
  let result = vulnerability.severity;
  for (const via of vulnerability.via) {
    if (isRecord(via) && severityRank[via.severity] > severityRank[result]) {
      result = via.severity;
    }
  }
  return result;
}

function isExactException(key, vulnerability) {
  if (
    key !== PACKAGE_NAME
    || vulnerability.name !== PACKAGE_NAME
    || vulnerability.severity !== "high"
    || vulnerability.isDirect !== false
    || vulnerability.nodes.length !== 1
    || vulnerability.nodes[0] !== AFFECTED_NODE
    || vulnerability.via.length !== 1
  ) {
    return false;
  }

  const advisory = vulnerability.via[0];
  return isRecord(advisory)
    && advisory.source === ADVISORY_SOURCE
    && advisory.url === ADVISORY_URL
    && advisory.name === PACKAGE_NAME
    && advisory.dependency === PACKAGE_NAME
    && advisory.severity === "high";
}

/**
 * Validate an npm audit v2 report with explicit, injectable installation/date evidence.
 * Throws on any condition that must fail the high-severity gate.
 */
export function validateAuditReport(report, evidence) {
  validateReportShape(report);

  let accepted = false;
  for (const [key, vulnerability] of Object.entries(report.vulnerabilities)) {
    const severity = gateSeverity(vulnerability);
    if (severity !== "high" && severity !== "critical") {
      continue;
    }
    if (!isExactException(key, vulnerability)) {
      fail(`unaccepted ${severity} vulnerability: ${key}`);
    }
    if (accepted) {
      fail(`duplicate accepted advisory entry: ${ADVISORY_ID}`);
    }
    const resolvedEvidence = typeof evidence === "function" ? evidence() : evidence;
    validateEvidence(resolvedEvidence);
    accepted = true;
  }

  if (!accepted) {
    return { acceptedAdvisory: null, expires: AUDIT_EXCEPTION_EXPIRES, warning: null };
  }

  return {
    acceptedAdvisory: ADVISORY_ID,
    expires: AUDIT_EXCEPTION_EXPIRES,
    warning: `WARNING: TEMPORARY SECURITY EXCEPTION ACCEPTED: ${ADVISORY_ID} (${ADVISORY_SOURCE}) for ${PACKAGE_NAME}@${BRACE_EXPANSION_VERSION} under @earendil-works/pi-coding-agent@${PI_CODING_AGENT_VERSION}; expires ${AUDIT_EXCEPTION_EXPIRES}.`,
  };
}

export function readAuditEvidenceFromLock(lock) {
  if (!isRecord(lock) || lock.lockfileVersion !== 3 || !isRecord(lock.packages)) {
    fail("malformed or unsupported package lock");
  }
  const braceExpansion = lock.packages[AFFECTED_NODE];
  const piCodingAgent = lock.packages["node_modules/@earendil-works/pi-coding-agent"];
  if (!isRecord(braceExpansion) || typeof braceExpansion.version !== "string") {
    fail(`package lock is missing exact ${AFFECTED_NODE} evidence`);
  }
  if (!isRecord(piCodingAgent) || typeof piCodingAgent.version !== "string") {
    fail("package lock is missing exact @earendil-works/pi-coding-agent evidence");
  }
  return {
    braceExpansionVersion: braceExpansion.version,
    piCodingAgentVersion: piCodingAgent.version,
  };
}

function readLockEvidence() {
  let lock;
  try {
    lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  } catch (error) {
    fail(`cannot read package lock: ${error instanceof Error ? error.message : String(error)}`);
  }
  return readAuditEvidenceFromLock(lock);
}

function run() {
  const audit = spawnSync("npm", ["audit", "--json"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });

  if (audit.error || (audit.status !== 0 && audit.status !== 1)) {
    fail(`npm audit command error${audit.error ? `: ${audit.error.message}` : ` (exit ${String(audit.status)})`}`);
  }

  let report;
  try {
    report = JSON.parse(audit.stdout);
  } catch {
    fail("npm audit returned malformed JSON (including possible command/network failure)");
  }

  const result = validateAuditReport(report, () => ({
    now: new Date(),
    ...readLockEvidence(),
  }));

  if (result.warning !== null) {
    console.warn(`\n*** ${result.warning} ***\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
