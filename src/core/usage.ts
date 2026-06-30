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

// Token/cost usage is reported in different shapes by different providers.
const TOKEN_KEYS = {
  input: ["input", "input_tokens", "inputTokens", "prompt_tokens", "promptTokens"],
  output: ["output", "output_tokens", "outputTokens", "completion_tokens", "completionTokens"],
} as const;

function readTokens(usage: any, kind: "input" | "output"): number {
  if (!usage || typeof usage !== "object") return 0;
  const keys = TOKEN_KEYS[kind];
  const direct = firstNumber(...keys.map((k) => usage[k]));
  if (direct) return direct;
  for (const container of ["usage", "tokens", "token_usage", "tokenUsage"]) {
    const inner = usage[container];
    if (inner && typeof inner === "object") {
      const v = firstNumber(...keys.map((k) => inner[k]));
      if (v) return v;
    }
  }
  return 0;
}

function readCost(usage: any): number {
  if (!usage || typeof usage !== "object") return 0;
  const direct = firstNumber(
    usage.cost?.total,
    usage.costUsd,
    typeof usage.cost === "number" ? usage.cost : undefined,
    usage.totalCost,
    usage.cost_usd,
    usage.cost?.usd,
  );
  if (direct) return direct;
  for (const container of ["usage", "token_usage", "tokenUsage"]) {
    const inner = usage[container];
    if (inner && typeof inner === "object") {
      const v = firstNumber(inner.cost?.total, inner.costUsd, typeof inner.cost === "number" ? inner.cost : undefined, inner.totalCost, inner.cost_usd);
      if (v) return v;
    }
  }
  return 0;
}

// Normalize any provider's usage object into { input, output, cost }.
export function extractUsage(usage: any): { input: number; output: number; cost: number } {
  return {
    input: readTokens(usage, "input"),
    output: readTokens(usage, "output"),
    cost: readCost(usage),
  };
}

export function modelFrom(ctx: ExtensionContext, requested?: string): string {
  if (requested && requested !== "inherit") return requested;
  const model = (ctx as any).model;
  if (model?.provider && model?.id) return `${model.provider}/${model.id}`;
  throw new Error("Cannot resolve model: agent requested 'inherit' but no session model is available. Set an explicit 'provider/id' model in the agent's frontmatter.");
}
