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

// Per-model reasoning-effort scale. Cheaper/faster models expose fewer steps.
// Keyed on the short model name (last path segment, lowercased).
export function thinkScale(model?: string): string[] {
  const m = shortModel(model).toLowerCase();
  if (m.includes("opus")) return ["off", "low", "med", "high", "max"];
  if (m.includes("sonnet")) return ["off", "low", "med", "high"];
  if (m.includes("haiku")) return ["off", "low"];
  return ["off", "low"];
}

// A free-form `thinking` string (e.g. "high", "medium", "off") → an index into
// the model's scale. Unknown/empty → 0 (off).
export function thinkLevel(model: string | undefined, thinking: string | undefined): number {
  const scale = thinkScale(model);
  if (!thinking) return 0;
  const t = thinking.trim().toLowerCase();
  const aliases: Record<string, string> = { medium: "med", maximum: "max", none: "off", minimal: "low" };
  const norm = aliases[t] || t;
  const i = scale.indexOf(norm);
  return i >= 0 ? i : 0;
}

export interface ThinkBar { w: number; h: number; on: boolean; }

// Ascending-height bar dial, filled up to `level`. `tier` sets bar geometry.
export function thinkBars(model: string | undefined, level: number, tier: "lead" | "worker"): ThinkBar[] {
  const scale = thinkScale(model);
  const n = scale.length;
  const boxW = tier === "lead" ? 25 : 14;
  const gap = tier === "lead" ? 2 : 1.3;
  const barW = Math.max(2, (boxW - gap * (n - 1)) / n);
  const maxH = tier === "lead" ? 9 : 7;
  const minH = tier === "lead" ? 3.5 : 2.5;
  const denom = n - 1 || 1;
  return scale.map((_, i) => ({
    w: +barW.toFixed(1),
    h: +(minH + (maxH - minH) * (i / denom)).toFixed(1),
    on: i <= level,
  }));
}

export function thinkName(model: string | undefined, level: number): string {
  return thinkScale(model)[level] || "off";
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

// Derived per-agent throughput. No live rate is stored, so approximate from
// cumulative tokens over elapsed wall time. Returns null when unknowable/idle.
export function tokPerSec(inputTokens = 0, outputTokens = 0, elapsedMs?: number): number | null {
  const tokens = (inputTokens || 0) + (outputTokens || 0);
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
