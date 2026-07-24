import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { isPathInside, resolveProjectPath } from "../core/safe-path";

export type ProtectedPathKind =
  | "project-boundary"
  | "artifact"
  | "knowledge"
  | "runtime-session"
  | "telemetry"
  | "authority-config"
  | "credential-secret"
  | "dashboard-auth"
  | "git-metadata";

export interface ProtectedPathRoot { readonly path: string; readonly kind: ProtectedPathKind }

export const DEFAULT_PROTECTED_PATHS: readonly ProtectedPathRoot[] = Object.freeze([
  Object.freeze({ path: ".pi/hive/hive-config.yaml", kind: "authority-config" }),
  Object.freeze({ path: ".pi/hive/workflows", kind: "authority-config" }),
  Object.freeze({ path: ".pi/hive/agents", kind: "authority-config" }),
  Object.freeze({ path: ".pi/hive/skills", kind: "authority-config" }),
  Object.freeze({ path: ".pi/hive/knowledge", kind: "knowledge" }),
  Object.freeze({ path: ".pi/hive/sessions", kind: "runtime-session" }),
  Object.freeze({ path: ".pi/hive/telemetry", kind: "telemetry" }),
  Object.freeze({ path: ".pi/hive/dashboard-auth", kind: "dashboard-auth" }),
  // Keep the package-owned state namespace closed even when a future child
  // directory has not yet been added to the specific registry above.
  Object.freeze({ path: ".pi/hive", kind: "authority-config" }),
  Object.freeze({ path: "openspec", kind: "artifact" }),
  Object.freeze({ path: "plans", kind: "artifact" }),
  Object.freeze({ path: ".git", kind: "git-metadata" }),
]);

const CREDENTIAL_NAMES = new Set([
  ".npmrc", ".pypirc", ".netrc", "credentials", "credentials.json", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
  "identity", "secring.gpg", "private-key.pem", "private_key.pem",
]);
const CREDENTIAL_SUFFIXES = [".key", ".pem", ".p12", ".pfx", ".jks", ".keystore"];

export interface ProtectedPathOptions {
  readonly allowMissing?: boolean;
  readonly secretPaths?: readonly string[];
  readonly additionalRoots?: readonly ProtectedPathRoot[];
}
export interface ProtectedPathDecision {
  readonly protected: boolean;
  readonly kind?: ProtectedPathKind;
}

function credentialPath(candidate: string): boolean {
  const lower = basename(candidate).toLocaleLowerCase("en-US");
  return lower.startsWith(".env") || CREDENTIAL_NAMES.has(lower) || CREDENTIAL_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function rootMatch(projectRoot: string, candidateLexical: string, candidateCanonical: string, root: ProtectedPathRoot): boolean {
  if (!root.path || isAbsolute(root.path)) return false;
  const protectedLexical = resolve(projectRoot, root.path);
  const protectedCanonical = resolveProjectPath(projectRoot, root.path, { allowMissing: true });
  return isPathInside(protectedLexical, candidateLexical)
    || Boolean(protectedCanonical && isPathInside(protectedCanonical.canonicalPath, candidateCanonical));
}

export function checkProtectedPath(projectRoot: string, requestedPath: string, options: ProtectedPathOptions = {}): ProtectedPathDecision {
  const candidate = resolveProjectPath(projectRoot, requestedPath, { allowMissing: options.allowMissing === true });
  if (!candidate) return Object.freeze({ protected: true, kind: "project-boundary" });
  if (credentialPath(candidate.lexicalPath) || credentialPath(candidate.canonicalPath)) return Object.freeze({ protected: true, kind: "credential-secret" });

  for (const root of [...DEFAULT_PROTECTED_PATHS, ...(options.additionalRoots ?? [])]) {
    if (rootMatch(projectRoot, candidate.lexicalPath, candidate.canonicalPath, root)) return Object.freeze({ protected: true, kind: root.kind });
  }
  for (const secret of options.secretPaths ?? []) {
    if (!secret || (isAbsolute(secret) && !isPathInside(projectRoot, secret))) continue;
    const root: ProtectedPathRoot = { path: relative(projectRoot, resolve(projectRoot, secret)).split(sep).join("/"), kind: "credential-secret" };
    if (rootMatch(projectRoot, candidate.lexicalPath, candidate.canonicalPath, root)) return Object.freeze({ protected: true, kind: "credential-secret" });
  }
  return Object.freeze({ protected: false });
}
