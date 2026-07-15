import { homedir } from "node:os";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { HIVE_SESSIONS_DIR } from "../core/constants";
import { isPathInside, resolveCanonicalPath } from "../core/safe-path";

export type ReservedPathAccess = "read" | "upsert" | "delete";

export interface ReservedPathOptions {
  secretPaths?: string[];
  // Core-owned persistence may opt out explicitly. Worker tool enforcement never
  // supplies this flag, so a broad domain cannot silently override reservations.
  trustedOverride?: boolean;
  allowMissing?: boolean;
}

export interface ReservedPathDecision {
  ok: boolean;
  reason?: string;
}

const PRIVATE_KEY_NAMES = new Set([
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "identity",
  "secring.gpg", "private-key.pem", "private_key.pem",
]);
const PRIVATE_KEY_SUFFIXES = [".key", ".pem", ".p12", ".pfx", ".jks", ".keystore"];

function pathSegments(value: string): string[] {
  return resolve(value).split(sep).filter(Boolean).map((part) => part.toLowerCase());
}

function sensitiveBasename(value: string): string | undefined {
  const base = basename(value).toLowerCase();
  if (base.startsWith(".env")) return ".env* files";
  if (PRIVATE_KEY_NAMES.has(base) || PRIVATE_KEY_SUFFIXES.some((suffix) => base.endsWith(suffix))) return "private key material";
  return undefined;
}

function matchesConfiguredSecret(projectRoot: string, candidate: string, secretPaths: string[]): boolean {
  return secretPaths.some((configured) => {
    if (!configured?.trim()) return false;
    const target = isAbsolute(configured) ? configured : resolve(projectRoot, configured);
    const canonical = resolveCanonicalPath(target, { allowMissing: true });
    return canonical ? isPathInside(canonical.canonicalPath, candidate) : isPathInside(target, candidate);
  });
}

function reservationReason(projectRoot: string, candidate: string, secretPaths: string[]): string | undefined {
  const agentDir = process.env.PI_CODING_AGENT_DIR || resolve(homedir(), ".pi", "agent");
  const globalHiveRoot = resolve(agentDir, "hive");
  if (isPathInside(globalHiveRoot, candidate)) return "pi-hive approval, daemon, registry, or telemetry authority";

  const projectSessions = resolve(projectRoot, HIVE_SESSIONS_DIR);
  if (isPathInside(projectSessions, candidate)) return "pi-hive session and telemetry state";

  if (candidate === resolve(projectRoot, ".pi-hive-approval.json")) return "legacy approval data";
  if (pathSegments(candidate).includes(".git")) return "Git repository metadata";

  const basenameReason = sensitiveBasename(candidate);
  if (basenameReason) return basenameReason;
  if (matchesConfiguredSecret(projectRoot, candidate, secretPaths)) return "configured secret path";
  return undefined;
}

export function checkReservedPath(
  projectRoot: string,
  requestedPath: string,
  _access: ReservedPathAccess,
  options: ReservedPathOptions = {},
): ReservedPathDecision {
  if (options.trustedOverride === true) return { ok: true };
  if (!requestedPath?.trim()) return { ok: false, reason: "empty path cannot be authorized" };

  const lexical = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(projectRoot, requestedPath);
  const canonical = resolveCanonicalPath(lexical, { allowMissing: options.allowMissing === true });
  // Check both names: lexical matching catches a symlink named like a reserved
  // target, while canonical matching catches an innocent-looking symlink that
  // resolves into reserved state.
  const reason = reservationReason(projectRoot, lexical, options.secretPaths || [])
    || (canonical ? reservationReason(projectRoot, canonical.canonicalPath, options.secretPaths || []) : undefined);
  return reason ? { ok: false, reason } : { ok: true };
}
