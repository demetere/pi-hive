export const SNAPSHOT_CONTEXT_POLICY = Object.freeze({
  version: "pi-hive-context-policy-v1",
  harnessReserve: 8_192,
  minimumDynamicReserve: 8_192,
  contextFraction: 0.2,
});

export type SnapshotModelDiagnosticCode = "SNAPSHOT_MODEL_UNAVAILABLE" | "SNAPSHOT_MODEL_ACTIVATION_FAILED" | "SNAPSHOT_THINKING_UNSUPPORTED" | "SNAPSHOT_CONTEXT_INSUFFICIENT" | "SNAPSHOT_CONTEXT_INVALID";
export interface SnapshotModelDescription { id: string; contextWindow: number; maxTokens?: number; thinking: readonly string[] }
export interface SnapshotModelAdapter {
  defaultModel: string;
  defaultThinking: string;
  find(modelId: string): SnapshotModelDescription | undefined;
  canActivate(modelId: string): boolean;
  estimateTokens(text: string): number;
}
export interface SnapshotNodeModelInput { nodeId: string; model?: string; thinking?: string; staticText: string; dynamicTokenReserve?: number }
export interface SnapshotNodeModelValidation { nodeId: string; modelId: string; thinking: string; staticTokens: number; dynamicReserve: number; contextWindow: number }
export type SnapshotModelValidationResult = { ok: true; nodes: SnapshotNodeModelValidation[]; codes: [] } | { ok: false; nodes: SnapshotNodeModelValidation[]; codes: SnapshotModelDiagnosticCode[] };
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

export function validateSnapshotModels(inputs: readonly SnapshotNodeModelInput[], adapter: SnapshotModelAdapter): SnapshotModelValidationResult {
  const nodes: SnapshotNodeModelValidation[] = [];
  const codes: SnapshotModelDiagnosticCode[] = [];
  for (const input of [...inputs].sort((a, b) => compare(a.nodeId, b.nodeId))) {
    const modelId = !input.model || input.model === "inherit" ? adapter.defaultModel : input.model;
    const model = adapter.find(modelId);
    if (!model) { codes.push("SNAPSHOT_MODEL_UNAVAILABLE"); continue; }
    if (!adapter.canActivate(modelId)) { codes.push("SNAPSHOT_MODEL_ACTIVATION_FAILED"); continue; }
    if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0 || (model.maxTokens !== undefined && (!Number.isSafeInteger(model.maxTokens) || model.maxTokens < 0))) { codes.push("SNAPSHOT_CONTEXT_INVALID"); continue; }
    const thinking = !input.thinking || input.thinking === "inherit" ? adapter.defaultThinking : input.thinking;
    if (typeof thinking !== "string" || !thinking) { codes.push("SNAPSHOT_THINKING_UNSUPPORTED"); continue; }
    if (!model.thinking.includes(thinking)) { codes.push("SNAPSHOT_THINKING_UNSUPPORTED"); continue; }
    const staticTokens = adapter.estimateTokens(input.staticText) + SNAPSHOT_CONTEXT_POLICY.harnessReserve;
    const dynamicPromptTokens = input.dynamicTokenReserve ?? 0;
    if (!Number.isSafeInteger(staticTokens) || staticTokens < 0 || !Number.isSafeInteger(dynamicPromptTokens) || dynamicPromptTokens < 0) { codes.push("SNAPSHOT_CONTEXT_INVALID"); continue; }
    const dynamicReserve = Math.max(dynamicPromptTokens, SNAPSHOT_CONTEXT_POLICY.minimumDynamicReserve, model.maxTokens ?? 0, Math.ceil(model.contextWindow * SNAPSHOT_CONTEXT_POLICY.contextFraction));
    if (staticTokens + dynamicReserve > model.contextWindow) { codes.push("SNAPSHOT_CONTEXT_INSUFFICIENT"); continue; }
    nodes.push({ nodeId: input.nodeId, modelId, thinking, staticTokens, dynamicReserve, contextWindow: model.contextWindow });
  }
  const unique = [...new Set(codes)];
  return unique.length ? { ok: false, nodes, codes: unique } : { ok: true, nodes, codes: [] };
}
