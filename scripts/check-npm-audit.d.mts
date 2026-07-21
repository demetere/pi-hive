export const AUDIT_EXCEPTION_EXPIRES: string;

export interface AuditEvidence {
  now: Date;
  braceExpansionVersion: string;
  piCodingAgentVersion: string;
}

export interface AuditValidationResult {
  acceptedAdvisory: string | null;
  expires: string;
  warning: string | null;
}

export function readAuditEvidenceFromLock(lock: unknown): Omit<AuditEvidence, "now">;
export function validateAuditReport(report: unknown, evidence: AuditEvidence | (() => AuditEvidence)): AuditValidationResult;
