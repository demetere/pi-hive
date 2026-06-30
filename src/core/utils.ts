// ── Helpers ──────────────────────────────────────────────────────────────────

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import type { AgentConfig, DomainScope, KnowledgeRef } from "./types";

export function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
}

// Convert "#rrggbb" to a truecolor ANSI-wrapped string. Returns null on bad
// input so callers can fall back to a theme role. `dim` halves the brightness
// (used for idle/secondary states). Shared by the status modal and the inline
// delegate_agent renderers so an agent shows in ITS OWN configured color
// everywhere, not a generic accent.
export function hexAnsi(hex: string | undefined, text: string, dim = false): string | null {
  if (!hex) return null;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  let r = parseInt(m[1].slice(0, 2), 16);
  let g = parseInt(m[1].slice(2, 4), 16);
  let b = parseInt(m[1].slice(4, 6), 16);
  if (dim) { r = Math.round(r * 0.5); g = Math.round(g * 0.5); b = Math.round(b * 0.5); }
  return `\u001b[38;2;${r};${g};${b}m${text}\u001b[39m`;
}

export function ensureDir(path: string) {
  mkdirSync(path, { recursive: true });
}

export function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

export function readIfSmall(path: string, maxBytes = 64_000): string {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > maxBytes) return "";
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

export function textFromMessage(message: any): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part: any) => part?.text || part?.content || "")
      .filter(Boolean)
      .join("\n");
  }
  if (typeof message.text === "string") return message.text;
  try {
    return JSON.stringify(message.content ?? message);
  } catch {
    return String(message);
  }
}

export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.65);
  const tail = Math.max(0, max - head - 32);
  return `${text.slice(0, head)}\n\n... [truncated] ...\n\n${text.slice(text.length - tail)}`;
}

export function tailLines(text: string, limit: number): string {
  const lines = text.split("\n").filter(Boolean);
  return lines.slice(Math.max(0, lines.length - limit)).join("\n");
}

export function extractFinalAnswer(text: string): string | null {
  const match = text.match(/<final_answer>([\s\S]*?)<\/final_answer>/i);
  return match?.[1]?.trim() || null;
}

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

// Token/cost usage is reported in different shapes by different providers
// (OpenAI Codex, Google, …). Rather than read a single field, dig tolerantly:
//   input:  input | input_tokens | prompt_tokens | promptTokens | inputTokens
//   output: output | output_tokens | completion_tokens | completionTokens | outputTokens
//   cost:   cost.total | costUsd | cost (number) | totalCost | cost_usd
// Each is also checked one level down under common containers (usage, tokens,
// usage.usage, token_usage) so a nested `{ usage: { input_tokens } }` still
// counts. Returns 0 when nothing matches — never NaN. This is what keeps the
// status widget's token/cost columns accurate across a mixed-provider hive.
const TOKEN_KEYS = {
  input: ["input", "input_tokens", "inputTokens", "prompt_tokens", "promptTokens"],
  output: ["output", "output_tokens", "outputTokens", "completion_tokens", "completionTokens"],
} as const;

function readTokens(usage: any, kind: "input" | "output"): number {
  if (!usage || typeof usage !== "object") return 0;
  const keys = TOKEN_KEYS[kind];
  const direct = firstNumber(...keys.map((k) => usage[k]));
  if (direct) return direct;
  // one level of nesting under common containers
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
  // No hardcoded model fallback: an explicit "provider/id" is used as-is; "inherit"
  // (or empty) resolves to the live session model. If neither is available, fail
  // loudly rather than silently picking a model.
  if (requested && requested !== "inherit") return requested;
  const model = (ctx as any).model;
  if (model?.provider && model?.id) return `${model.provider}/${model.id}`;
  throw new Error("Cannot resolve model: agent requested 'inherit' but no session model is available. Set an explicit 'provider/id' model in the agent's frontmatter.");
}

export function normalizeTools(tools: string | undefined, fallback: string): string {
  return (tools || fallback || "read, grep, find, ls")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean)
    .join(",");
}

export function normalizeWorkerTools(tools: string | undefined, fallback: string): string {
  // Nested delegation is intentionally enabled: workers may receive extension
  // tools such as delegate_agent when their per-agent config grants them.
  return normalizeTools(tools, fallback);
}

export function normalizeStringList(value: any): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

export function normalizeKnowledgeRefs(value: any): KnowledgeRef[] {
  if (!value) return [];
  const entries = Array.isArray(value) ? value : [value];
  return entries
    .map((entry) => typeof entry === "string" ? { path: entry } : entry)
    .filter((entry) => entry?.path)
    .map((entry) => ({
      path: String(entry.path),
      useWhen: entry.useWhen ? String(entry.useWhen) : undefined,
      updatable: Boolean(entry.updatable),
    }));
}

// Coerce a raw YAML capability value into the tri-state used by the matcher:
//   true  → explicit allow, false → explicit deny, undefined → no opinion.
// Anything other than a literal boolean (missing key, null, stray string) is
// treated as "no opinion" so it defers to other scopes rather than silently
// allowing or denying.
function triState(value: any): boolean | undefined {
  if (value === true) return true;
  if (value === false) return false;
  return undefined;
}

export function normalizeDomainScopes(value: any): DomainScope[] {
  if (!value) return [];
  const entries = Array.isArray(value) ? value : [value];
  return entries
    // A bare string scope ("path/to/dir") is shorthand for "allow read here".
    .map((entry) => typeof entry === "string" ? { path: entry, read: true } : entry)
    .filter((entry) => entry?.path)
    .map((entry) => {
      const read = triState(entry.read);
      return {
        path: String(entry.path),
        // Back-compat: a scope that omits `read` historically meant read-allow.
        // Preserve that (omitted → true) while still honoring an explicit
        // `read: false` as a deny. upsert/delete keep full tri-state: omitted
        // means "no opinion" so broader scopes can decide.
        read: read === undefined ? true : read,
        upsert: triState(entry.upsert),
        delete: triState(entry.delete),
        description: entry.description ? String(entry.description) : undefined,
      };
    });
}

export function uniqueAgents(agents: AgentConfig[]): AgentConfig[] {
  const seen = new Set<string>();
  const unique: AgentConfig[] = [];
  for (const agent of agents) {
    const key = agent.name?.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(agent);
  }
  return unique;
}

export function configuredChildAgents(agent: AgentConfig): AgentConfig[] {
  return uniqueAgents([...(agent.members || []), ...(agent.children || [])]);
}

export function flatAgentConfig(agent: AgentConfig): AgentConfig {
  const { members: _members, children: _children, ...flatAgent } = agent;
  return flatAgent;
}

export function agentTreeContains(agent: AgentConfig, agentName: string, childrenOverride?: AgentConfig[]): boolean {
  if (agent.name.toLowerCase() === agentName.toLowerCase()) return true;
  const children = childrenOverride || configuredChildAgents(agent);
  return children.some((child) => agentTreeContains(child, agentName));
}
