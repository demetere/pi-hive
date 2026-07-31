export type ApiResource = "projects" | "workflows" | "sessions" | "runs" | "nodes" | "tasks" | "artifacts" | "checkpoints" | "questions" | "approvals" | "knowledge" | "usage" | "activity" | "history";

export type DashboardView = ApiResource | "overview" | "evidence" | "cost" | "model-mix" | "knowledge-bundles" | "knowledge-jobs" | "knowledge-proposals";

export interface NavigationGroup {
  readonly label: string;
  readonly views: readonly DashboardView[];
}

export const NAV_GROUPS: readonly NavigationGroup[] = [
  { label: "Mission control", views: ["overview", "workflows", "sessions"] },
  { label: "Execution", views: ["tasks", "activity", "history"] },
  { label: "Governance", views: ["artifacts", "evidence", "checkpoints", "questions", "approvals"] },
  { label: "Knowledge", views: ["knowledge-bundles", "knowledge-jobs", "knowledge-proposals"] },
  { label: "Insights", views: ["cost", "model-mix", "usage"] },
];

export const VIEW_TITLES: Readonly<Record<DashboardView, string>> = {
  overview: "Overview", projects: "Projects", workflows: "Workflows", sessions: "Sessions", runs: "Runs", nodes: "Topology", tasks: "Tasks", artifacts: "Artifacts",
  evidence: "Evidence", checkpoints: "Checkpoints", questions: "Questions", approvals: "Approvals", "knowledge-bundles": "Knowledge bundles",
  "knowledge-jobs": "Knowledge jobs", "knowledge-proposals": "Knowledge proposals", knowledge: "Knowledge", cost: "Cost", "model-mix": "Model mix", usage: "Usage", activity: "Activity", history: "History",
};

export const VIEW_SUBTITLES: Readonly<Record<DashboardView, string>> = {
  overview: "Live workflow health, topology, activity, and usage at a glance.", projects: "Registered live projects and retained historical project projections.", workflows: "Cataloged workflow definitions, immutable versions, and configured topology.", sessions: "Linked Pi sessions carrying workflow execution state.", runs: "Durable workflow runs and their terminal or active status.", nodes: "The live hierarchical agent topology instantiated by projected runs.", tasks: "Delegated work owned by workflow nodes.", artifacts: "Bound artifact workspaces without exposing private content.", evidence: "Verified event references projected from authoritative journals.", checkpoints: "Artifact checkpoint requests and current decisions.", questions: "Durable human questions awaiting exact typed answers.", approvals: "Human approval controls with exact request provenance.", "knowledge-bundles": "Bounded knowledge updates available to workflows.", "knowledge-jobs": "Durable enrichment work and model attribution.", "knowledge-proposals": "Human-reviewed knowledge changes awaiting decisions.", knowledge: "Projected knowledge lifecycle state.", cost: "Provider-confirmed and explicitly separated estimated spend.", "model-mix": "Token usage grouped by model and precision.", usage: "Authoritative token and cost counters by precision.", activity: "The newest projected workflow events.", history: "Bounded durable workflow event history.",
};
