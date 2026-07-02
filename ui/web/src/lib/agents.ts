// Agent-card helpers ported 1:1 from the "Soft Signal / Dusk" design source
// (design_handoff_pi_hive_overview/pi-hive-overview.source.dc.html). These drive
// the topology cards, activity roster, and status treatments.

import { shortModel } from "./format";

export type StatusKey = "running" | "waiting" | "done" | "error" | "idle";

// Map any incoming status string onto the four-color status vocabulary.
export function statusKey(s: string | undefined): StatusKey {
  switch (s) {
    case "running": return "running";
    case "waiting": return "waiting";
    case "done": return "done";
    case "error": return "error";
    default: return "idle";
  }
}

// CSS var for a status color. `idle` reads as `waiting` (slate) — a resting node.
export function statusColorVar(s: string | undefined): string {
  switch (statusKey(s)) {
    case "running": return "var(--run)";
    case "done": return "var(--done)";
    case "error": return "var(--crit)";
    default: return "var(--wait)";
  }
}

// Context-window pressure → fill color. ≤60% neutral, 61–85% warn, >85% crit.
export function ctxColor(pct: number): string {
  return pct > 85 ? "var(--crit)" : pct > 60 ? "var(--warn)" : "var(--ink-dim)";
}

// Canonical reasoning-effort ordering used across pi models
// (["off","minimal","low","medium","high","xhigh"]). We don't have each model's
// exact supported subset in telemetry, so the dial is built on this full scale
// and the agent's actual `thinking` value selects the level — which reads
// correctly for any model (gpt, gemini, claude, …) rather than assuming a fixed
// per-family scale. Normalizes common aliases (med→medium, max→xhigh).
export const THINK_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

function normLevel(v: string | undefined): string {
  if (!v) return "off";
  const t = v.trim().toLowerCase();
  const alias: Record<string, string> = { med: "medium", max: "xhigh", maximum: "xhigh", none: "off", mid: "medium" };
  return alias[t] || t;
}

// The levels the dial should show. When the (already-resolved) supported levels
// are known — node sidecar, or a /models lookup by effective model (K3) — the
// dial shows exactly those, in canonical order, no invented ladder. When they
// are NOT known, this returns [] so the caller renders the chosen level as plain
// text instead of fabricating a full 6-level scale (Decision 6).
export function thinkScale(supportedLevels?: string[]): string[] {
  if (supportedLevels && supportedLevels.length) {
    const set = new Set(supportedLevels.map((l) => normLevel(l)));
    const ordered = THINK_ORDER.filter((l) => set.has(l));
    if (ordered.length) return ordered;
  }
  return [];
}

// A free-form `thinking` string → index into the canonical scale. Unknown → 0.
export function thinkLevel(_model: string | undefined, thinking: string | undefined): number {
  const i = THINK_ORDER.indexOf(normLevel(thinking) as (typeof THINK_ORDER)[number]);
  return i >= 0 ? i : 0;
}

export interface ThinkBar { w: number; h: number; on: boolean; }

// Ascending-height bar dial. Bars represent the ACTIVE effort levels only
// (minimal…xhigh) — "off" (level 0) fills nothing, so the dial is all-gray when
// an agent isn't thinking. A bar for level i (1-indexed) is on when level >= i.
// When SDK-supported levels are known (thinkingLevels sidecar, E4), the dial
// shows exactly that many bars (minus "off"); otherwise the full canonical scale.
export function thinkBars(supportedLevels: string[] | undefined, level: number, tier: "lead" | "worker"): ThinkBar[] {
  const scale = thinkScale(supportedLevels);
  // Unknown capabilities → no bars; the caller renders the level as plain text.
  if (!scale.length) return [];
  const n = Math.max(1, scale.filter((l) => l !== "off").length); // exclude "off"
  const boxW = tier === "lead" ? 34 : 20;
  const gap = tier === "lead" ? 2 : 1.2;
  const barW = Math.max(1.6, (boxW - gap * (n - 1)) / n);
  const maxH = tier === "lead" ? 9 : 7;
  const minH = tier === "lead" ? 3.5 : 2.5;
  const denom = n - 1 || 1;
  return Array.from({ length: n }, (_, k) => ({
    w: +barW.toFixed(1),
    h: +(minH + (maxH - minH) * (k / denom)).toFixed(1),
    on: level >= k + 1, // bar k represents level k+1 (minimal=1 … xhigh=5)
  }));
}

export function thinkName(_model: string | undefined, level: number): string {
  return THINK_ORDER[level] || "off";
}

// Resolve the supported thinking levels for the dial (K3/Decision 6), in order:
//   1. the node's own thinkingLevels sidecar (from the topology / delegation),
//   2. the runtime's thinkingLevels sidecar (from the live snapshot),
//   3. a /models lookup by the effective model string (full "provider/id" or
//      bare id, lowercased — the two keys refreshModels indexes),
//   4. undefined → the caller renders the chosen level as plain text.
// Never fabricates a ladder.
export function resolveDialLevels(
  nodeLevels: string[] | undefined,
  rtLevels: string[] | undefined,
  model: string | undefined,
  modelLevels?: Map<string, string[]>,
): string[] | undefined {
  if (nodeLevels && nodeLevels.length) return nodeLevels;
  if (rtLevels && rtLevels.length) return rtLevels;
  if (model && modelLevels) {
    const raw = model.trim().toLowerCase();
    const bare = raw.includes("/") ? raw.slice(raw.indexOf("/") + 1) : raw;
    const hit = modelLevels.get(raw) || modelLevels.get(bare);
    if (hit && hit.length) return hit;
  }
  return undefined;
}

// Single-letter neutral model badge, e.g. "opus" → "O". Never color-coded.
export function modelLetter(model?: string): string {
  const m = shortModel(model);
  return (m[0] || "?").toUpperCase();
}

// A recognizable model tag for the topology card badge — keeps the meaningful
// identity (family + version + variant) so it disambiguates, e.g.
// "gemini-3.5-flash" → "gemini-3.5-flash", "claude-opus-4-8" → "opus-4.8",
// "gpt-5.5" → "gpt-5.5". Drops only vendor prefixes/date suffixes. Never
// color-coded. Cards size themselves to fit the tag, so it need not be tiny.
export function modelTag(model?: string): string {
  let raw = shortModel(model).toLowerCase();
  if (!raw || raw === "inherit") return "—";
  // Drop a trailing date stamp like "-20251001".
  raw = raw.replace(/-?\d{6,8}$/, "");
  // Anthropic: drop the "claude-" vendor prefix, keep tier + version.
  raw = raw.replace(/^claude-/, "");
  // Normalize "opus-4-8" → "opus-4.8" (dash-joined version parts read as a dot).
  raw = raw.replace(/(opus|sonnet|haiku)-(\d+)-(\d+)/, "$1-$2.$3");
  return raw;
}

// Per-run throughput (K4/Decision 4). elapsedMs resets each run in dispatch.ts,
// so the rate must divide the tokens produced DURING this run — the live totals
// minus the run-start baselines (J8) — by that same per-run elapsed. Falls back
// to lifetime totals only when no baseline was recorded (pre-J8 snapshots), so a
// re-run agent's rate is no longer inflated by prior runs' tokens. Returns null
// when unknowable/idle.
export function tokPerSec(
  inputTokens = 0,
  outputTokens = 0,
  elapsedMs?: number,
  runStartInputTokens?: number,
  runStartOutputTokens?: number,
): number | null {
  const lifetime = (inputTokens || 0) + (outputTokens || 0);
  const baseline = (runStartInputTokens || 0) + (runStartOutputTokens || 0);
  // Guard against a baseline above the live total (snapshot ordering skew).
  const tokens = runStartInputTokens != null || runStartOutputTokens != null
    ? Math.max(0, lifetime - baseline)
    : lifetime;
  if (!tokens || !elapsedMs || elapsedMs <= 0) return null;
  return tokens / (elapsedMs / 1000);
}

// Quadratic-bezier midpoint smoothing for calm, non-jagged chart lines.
// Ported 1:1 from the design source `smooth()`.
export function smooth(pts: [number, number][]): string {
  if (pts.length < 2) return "";
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const xc = (pts[i - 1][0] + pts[i][0]) / 2;
    const yc = (pts[i - 1][1] + pts[i][1]) / 2;
    d += ` Q ${pts[i - 1][0].toFixed(1)} ${pts[i - 1][1].toFixed(1)} ${xc.toFixed(1)} ${yc.toFixed(1)}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last[0].toFixed(1)} ${last[1].toFixed(1)}`;
  return d;
}

// HH:MM:SS wall clock from an epoch-ms timestamp.
export function hhmmss(ms: number): string {
  const d = new Date(ms || Date.now());
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}
