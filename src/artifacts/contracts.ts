import type { ConfigDiagnosticCode } from "../config/diagnostics";

export const ARTIFACT_CONTRACT_VERSION = "pi-hive-artifact-contract-v1" as const;
export type ArtifactBinding = "none" | "new" | "existing" | "either";
export interface ArtifactProfileContract {
  adapter: string;
  profile: string;
  bindings: readonly ArtifactBinding[];
  checkpoints: readonly string[];
}
const author = Object.freeze(["new", "existing", "either"] as const);
const existing = Object.freeze(["existing"] as const);
const contract = (adapter: string, profile: string, bindings: readonly ArtifactBinding[], checkpoints: readonly string[]): ArtifactProfileContract => Object.freeze({
  adapter,
  profile,
  bindings: Object.freeze([...bindings]),
  checkpoints: Object.freeze([...checkpoints]),
});
export const BUILTIN_ARTIFACT_PROFILES: readonly ArtifactProfileContract[] = Object.freeze([
  contract("none", "default", ["none"], []),
  contract("markdown-plan", "author", author, ["plan"]),
  contract("markdown-plan", "execute", existing, ["plan", "execution"]),
  contract("markdown-plan", "review", existing, ["execution", "review"]),
  contract("markdown-plan", "lifecycle", author, ["plan", "execution", "review"]),
  contract("openspec", "author", author, ["proposal", "design", "specs", "tasks"]),
  contract("openspec", "execute", existing, ["tasks", "implementation"]),
  contract("openspec", "review", existing, ["implementation", "review"]),
  contract("openspec", "lifecycle", author, ["proposal", "design", "specs", "tasks", "implementation", "review"]),
]);
export function artifactProfileContract(adapter: string, profile: string): ArtifactProfileContract | undefined {
  return BUILTIN_ARTIFACT_PROFILES.find((item) => item.adapter === adapter && item.profile === profile);
}
export function validateArtifactDeclaration(
  artifact: { adapter: string; profile: string; binding: string; options?: Record<string, unknown> },
  approvals: Record<string, unknown> | undefined,
): { contract?: ArtifactProfileContract; codes: ConfigDiagnosticCode[] } {
  const codes: ConfigDiagnosticCode[] = [];
  const contract = artifactProfileContract(artifact.adapter, artifact.profile);
  if (!contract) return { codes: ["ARTIFACT_PROFILE_UNKNOWN"] };
  if (!contract.bindings.includes(artifact.binding as ArtifactBinding)) codes.push("ARTIFACT_BINDING_INVALID");
  if (artifact.options && Object.keys(artifact.options).length > 0) codes.push("ARTIFACT_OPTIONS_UNKNOWN");
  const actual = new Set(Object.keys(approvals ?? {}));
  for (const id of contract.checkpoints) if (!actual.has(id)) codes.push("WORKFLOW_CHECKPOINT_MISSING");
  for (const id of actual) if (!contract.checkpoints.includes(id)) codes.push("WORKFLOW_CHECKPOINT_UNKNOWN");
  return { contract, codes };
}
