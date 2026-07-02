export function fmtNum(n: number): string {
  if (!isFinite(n)) return "0";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + "k";
  return String(Math.round(n));
}

export function fmtCost(n: number): string {
  return "$" + Number(n || 0).toFixed(2);
}

// Human byte size (KB/MB/GB, base 1024). Sub-KB shown as B.
export function fmtBytes(n: number): string {
  const b = Number(n) || 0;
  if (b < 1024) return `${Math.round(b)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function relTime(ts: string | number, now = Date.now()): string {
  const t = typeof ts === "number" ? ts : new Date(ts).getTime();
  const s = Math.round((now - t) / 1000);
  if (!isFinite(s)) return "";
  if (s < 5) return "just now";
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}

export { projectName } from "../../../../src/shared/project";

// The short, human part of a session id (drops the date prefix, keeps time+slug).
export function shortSessionId(id: string): string {
  // "2026-06-29T19-11-20-115Z-ctbb08" -> "19-11-20 · ctbb08"
  const m = id.match(/T(\d{2}-\d{2}-\d{2})-\d+Z-(.+)$/);
  if (m) return m[1] + " · " + m[2];
  return id.slice(0, 22);
}

// Just the random slug portion of a session id ("ctbb08"), no time.
export function sessionSlug(id: string): string {
  const m = id.match(/Z-(.+)$/);
  return m ? m[1] : id.slice(0, 8);
}

// Absolute local date+time for a session timestamp, e.g. "Jun 29, 19:11".
export function absTime(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function clip(s: unknown, n: number): string {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

export function shortModel(model?: string): string {
  if (!model) return "inherit";
  return String(model).split("/").pop() || model;
}
