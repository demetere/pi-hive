import type { RawAgentBudgets, RawWorkflowBudgets } from "./types";

export const PACKAGE_BUDGET_CAPS = Object.freeze({
  "max-parallel": 32,
  "max-delegations": 4_096,
  "max-agent-turns": 256,
  "max-tool-calls": 100_000,
  "token-budget": 100_000_000,
  "active-wall-time": 86_400_000,
});
export type BudgetField = keyof typeof PACKAGE_BUDGET_CAPS;
export type BudgetSource = "package" | "project" | "workflow" | "agent" | "node";
export interface BudgetCandidate { source: BudgetSource; value: number; declared?: number | string }
export interface ResolvedBudgetField { scope: "run" | "node"; effective: number; candidates: BudgetCandidate[] }
export interface ResolvedBudgetDeclarations { run: Record<BudgetField, ResolvedBudgetField>; node: Record<Exclude<BudgetField, "max-parallel" | "max-delegations">, ResolvedBudgetField>; invalidFields: BudgetField[] }

export function parseDurationV1(value: string): number | undefined {
  const match = /^([1-9][0-9]*)(ms|s|m|h)$/.exec(value);
  if (!match) return undefined;
  const multiplier = match[2] === "ms" ? 1 : match[2] === "s" ? 1_000 : match[2] === "m" ? 60_000 : 3_600_000;
  const numeric = Number(match[1]);
  if (!Number.isSafeInteger(numeric) || numeric > Math.floor(Number.MAX_SAFE_INTEGER / multiplier)) return undefined;
  const result = numeric * multiplier;
  return Number.isSafeInteger(result) ? result : undefined;
}
function declaredValue(raw: RawWorkflowBudgets | RawAgentBudgets | undefined, field: BudgetField): number | undefined {
  const value = raw?.[field as keyof typeof raw];
  if (typeof value === "number") return value;
  return typeof value === "string" ? parseDurationV1(value) : undefined;
}
export function validateBudgetDeclarations(raw: RawWorkflowBudgets | RawAgentBudgets | undefined): BudgetField[] {
  if (!raw) return [];
  const invalid: BudgetField[] = [];
  for (const field of Object.keys(raw) as BudgetField[]) {
    const value = declaredValue(raw, field);
    if (value === undefined || value > PACKAGE_BUDGET_CAPS[field]) invalid.push(field);
  }
  return invalid;
}
function resolveField(field: BudgetField, scope: "run" | "node", declarations: { project?: RawWorkflowBudgets; workflow?: RawWorkflowBudgets; agent?: RawAgentBudgets; node?: RawAgentBudgets }): ResolvedBudgetField {
  const candidates: BudgetCandidate[] = [{ source: "package", value: PACKAGE_BUDGET_CAPS[field] }];
  const ordered: Array<[BudgetSource, RawWorkflowBudgets | RawAgentBudgets | undefined]> = [["project", declarations.project], ["workflow", declarations.workflow], ["agent", declarations.agent], ["node", declarations.node]];
  for (const [source, raw] of ordered) {
    if (scope === "run" && (source === "agent" || source === "node")) continue;
    const value = declaredValue(raw, field);
    if (value !== undefined) candidates.push({ source, value, declared: raw?.[field as keyof typeof raw] as number | string });
  }
  return { scope, effective: Math.min(...candidates.map((x) => x.value)), candidates };
}
export function resolveBudgetDeclarations(declarations: { project?: RawWorkflowBudgets; workflow?: RawWorkflowBudgets; agent?: RawAgentBudgets; node?: RawAgentBudgets }): ResolvedBudgetDeclarations {
  const invalidFields = [...new Set([
    ...validateBudgetDeclarations(declarations.project),
    ...validateBudgetDeclarations(declarations.workflow),
    ...validateBudgetDeclarations(declarations.agent),
    ...validateBudgetDeclarations(declarations.node),
  ])].sort();
  const run = {} as ResolvedBudgetDeclarations["run"];
  for (const field of Object.keys(PACKAGE_BUDGET_CAPS) as BudgetField[]) run[field] = resolveField(field, "run", declarations);
  const node = {} as ResolvedBudgetDeclarations["node"];
  for (const field of ["max-agent-turns", "max-tool-calls", "token-budget", "active-wall-time"] as const) {
    const candidates: BudgetCandidate[] = [{ source: "package", value: PACKAGE_BUDGET_CAPS[field] }];
    for (const [source, raw] of [["project", declarations.project], ["workflow", declarations.workflow], ["agent", declarations.agent], ["node", declarations.node]] as const) {
      const value = declaredValue(raw, field);
      if (value !== undefined) candidates.push({ source, value, declared: raw?.[field] });
    }
    node[field] = { scope: "node", effective: Math.min(...candidates.map((x) => x.value)), candidates };
  }
  return { run, node, invalidFields };
}
