import type { Static } from "typebox";
import type {
  AgentFrontmatterV1Schema,
  JsonValueSchema,
  ManifestV1Schema,
  RawAgentBudgetsSchema,
  RawCapabilitiesSchema,
  RawTeamNodeV1Schema,
  RawWorkflowBudgetsSchema,
  WorkflowV1Schema,
} from "./schema";

export type JsonValue = Static<typeof JsonValueSchema>;
export type RawCapabilities = Static<typeof RawCapabilitiesSchema>;
export type RawAgentBudgets = Static<typeof RawAgentBudgetsSchema>;
export type RawWorkflowBudgets = Static<typeof RawWorkflowBudgetsSchema>;
export type RawManifestV1 = Static<typeof ManifestV1Schema>;
export type RawAgentFrontmatterV1 = Static<typeof AgentFrontmatterV1Schema>;
export type RawTeamNodeV1 = Static<typeof RawTeamNodeV1Schema>;
export type RawWorkflowV1 = Static<typeof WorkflowV1Schema>;
