import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function usageNumber(value: any): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// Pick the first finite number among several candidate values.
function firstNumber(...candidates: any[]): number {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
  }
  return 0;
}

// Normalized usage totals. `cost` is SDK-priced (pi-ai computes it); pi-hive
// keeps no pricing table of its own.
export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cost: number;
}

// Normalize a pi-ai `Usage` object into typed totals. Every worker session is
// created via pi's own createAgentSession and always yields the canonical shape
// (input/output/cacheRead/cacheWrite/reasoning + cost.total). One legacy
// fallback (`input_tokens`/`output_tokens`) is kept for pre-canonical logs read
// back during replay.
export function extractUsage(usage: any): UsageTotals {
  if (!usage || typeof usage !== "object") {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 };
  }
  return {
    input: firstNumber(usage.input, usage.input_tokens),
    output: firstNumber(usage.output, usage.output_tokens),
    cacheRead: firstNumber(usage.cacheRead),
    cacheWrite: firstNumber(usage.cacheWrite, usage.cacheWrite1h),
    reasoning: firstNumber(usage.reasoning),
    cost: firstNumber(usage.cost?.total, typeof usage.cost === "number" ? usage.cost : undefined),
  };
}

export function modelFrom(ctx: ExtensionContext, requested?: string): string {
  if (requested && requested !== "inherit") return requested;
  const model = (ctx as any).model;
  if (model?.provider && model?.id) return `${model.provider}/${model.id}`;
  throw new Error("Cannot resolve model: agent requested 'inherit' but no session model is available. Set an explicit 'provider/id' model in the agent's frontmatter.");
}
