// Canonical pi-hive view of the OpenSpec artifact graph. Runtime policy,
// dispatch, review, and dashboard code must derive artifact names and ordering
// from this table rather than maintaining parallel lists.

export const OPENSPEC_ARTIFACTS = [
  {
    id: "proposal",
    displayLabel: "Proposal",
    outputPath: "proposal.md",
    dependencies: [],
    plannerStage: "proposal",
    reviewOrder: 0,
    hashStrategy: "exact-file-sha256",
  },
  {
    id: "design",
    displayLabel: "Design",
    outputPath: "design.md",
    dependencies: ["proposal"],
    plannerStage: "design",
    reviewOrder: 1,
    hashStrategy: "exact-file-sha256",
  },
  {
    id: "specs",
    displayLabel: "Specification deltas",
    outputPath: "specs/**/*.md",
    dependencies: ["proposal"],
    plannerStage: "specs",
    reviewOrder: 2,
    hashStrategy: "sorted-path-and-content-sha256",
  },
  {
    id: "tasks",
    displayLabel: "Tasks",
    outputPath: "tasks.md",
    dependencies: ["design", "specs"],
    plannerStage: "tasks",
    reviewOrder: 3,
    hashStrategy: "exact-file-sha256",
  },
] as const;

export type OpenSpecArtifact = (typeof OPENSPEC_ARTIFACTS)[number];
export type ArtifactId = OpenSpecArtifact["id"];
export type PlanStage = OpenSpecArtifact["plannerStage"];
export type ArtifactHashStrategy = OpenSpecArtifact["hashStrategy"];

export const ARTIFACT_ORDER = OPENSPEC_ARTIFACTS.map((artifact) => artifact.id) as readonly ArtifactId[];

export function artifactDefinition(id: string): OpenSpecArtifact | undefined {
  return OPENSPEC_ARTIFACTS.find((artifact) => artifact.id === id);
}

export function artifactIdFromReference(reference: string): ArtifactId | null {
  const normalized = reference.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized === "proposal" || normalized.endsWith("/proposal.md") || normalized === "proposal.md") return "proposal";
  if (normalized === "design" || normalized.endsWith("/design.md") || normalized === "design.md") return "design";
  if (normalized === "tasks" || normalized.endsWith("/tasks.md") || normalized === "tasks.md") return "tasks";
  if (normalized === "specs" || normalized.startsWith("specs/") || normalized.includes("/specs/")) return "specs";
  return null;
}

export function artifactDependencies(id: ArtifactId): readonly ArtifactId[] {
  return (artifactDefinition(id)?.dependencies ?? []) as readonly ArtifactId[];
}
