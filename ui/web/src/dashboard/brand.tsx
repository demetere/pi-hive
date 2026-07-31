import type { DashboardView } from "./navigation";

export function NavIcon({ view }: { view: DashboardView }) {
  const common = { width: 17, height: 17, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.45, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (view === "overview") return <svg {...common}><rect x="2" y="2" width="5" height="5" rx="1.2" /><rect x="9" y="2" width="5" height="5" rx="1.2" /><rect x="2" y="9" width="5" height="5" rx="1.2" /><rect x="9" y="9" width="5" height="5" rx="1.2" /></svg>;
  if (view === "workflows") return <svg {...common}><circle cx="8" cy="3" r="1.6" /><circle cx="3.5" cy="12" r="1.6" /><circle cx="12.5" cy="12" r="1.6" /><path d="M8 4.7v2.2M3.5 10.3V8h9v2.3" /></svg>;
  if (view === "sessions") return <svg {...common}><rect x="2" y="4" width="9" height="9" rx="1.5" /><path d="M5 4V2.5h9v9h-3" /></svg>;
  if (view === "runs") return <svg {...common}><circle cx="8" cy="8" r="6" /><path d="m6.5 5 4.5 3-4.5 3Z" /></svg>;
  if (view === "tasks") return <svg {...common}><rect x="2" y="2" width="12" height="12" rx="2" /><path d="m4.5 8 2 2 5-5" /></svg>;
  if (view === "activity") return <svg {...common}><path d="M1.5 8h3l1.4-4 3 8 1.7-5 1.1 1H14.5" /></svg>;
  if (view === "history") return <svg {...common}><circle cx="8" cy="8" r="5.7" /><path d="M8 4.5V8l2.5 1.5M3 3.5v3h3" /></svg>;
  if (view === "artifacts") return <svg {...common}><path d="m2.5 5 5.5-3 5.5 3v6L8 14l-5.5-3Z" /><path d="m2.5 5 5.5 3 5.5-3M8 8v6" /></svg>;
  if (view === "evidence") return <svg {...common}><path d="M8 1.8 13 4v3.6c0 3.2-2.1 5.3-5 6.6-2.9-1.3-5-3.4-5-6.6V4Z" /><path d="m5.5 8 1.6 1.6 3.5-3.5" /></svg>;
  if (view === "checkpoints") return <svg {...common}><path d="M3 14V2M3 3h8l-1.5 2L11 7H3" /></svg>;
  if (view === "questions") return <svg {...common}><path d="M2 3.5A2.5 2.5 0 0 1 4.5 1h7A2.5 2.5 0 0 1 14 3.5v5A2.5 2.5 0 0 1 11.5 11H7l-3.5 3v-3.2A2.5 2.5 0 0 1 2 8.5Z" /><path d="M6.4 5.2A1.7 1.7 0 0 1 8 4.2c1 0 1.8.6 1.8 1.5 0 1.1-1.8 1.3-1.8 2.4M8 9.5h.01" /></svg>;
  if (view === "approvals") return <svg {...common}><circle cx="8" cy="8" r="6" /><path d="m4.8 8 2.1 2.1 4.3-4.3" /></svg>;
  if (view === "knowledge-bundles") return <svg {...common}><path d="M3 2.5h7.5A2.5 2.5 0 0 1 13 5v8.5H5A2 2 0 0 1 3 11.5v-9Z" /><path d="M5 13.5v-9h8" /></svg>;
  if (view === "knowledge-jobs") return <svg {...common}><circle cx="8" cy="8" r="2.4" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" /></svg>;
  if (view === "knowledge-proposals") return <svg {...common}><path d="M3 2h7l3 3v9H3Z" /><path d="M10 2v3h3M8 7v4M6 9h4" /></svg>;
  if (view === "cost") return <svg {...common}><path d="M8 1.8v12.4M11 4.2H6.6a2 2 0 1 0 0 4h2.8a2 2 0 1 1 0 4H4.7" /></svg>;
  if (view === "model-mix") return <svg {...common}><circle cx="5" cy="5" r="3" /><circle cx="11" cy="5" r="3" /><circle cx="8" cy="11" r="3" /></svg>;
  if (view === "usage") return <svg {...common}><path d="M2 13.5h12M3.5 11V7.5h2V11M7 11V3h2v8M10.5 11V5.5h2V11" /></svg>;
  if (view === "nodes") return <svg {...common}><path d="M8 2v4M4 10V8h8v2" /><circle cx="8" cy="2" r="1" /><circle cx="4" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /></svg>;
  return <svg {...common}><path d="M3 2.5h7l3 3v8H3z" /><path d="M10 2.5v3h3" /></svg>;
}

export function HiveMark({ compact = false }: { compact?: boolean }) {
  return <span className={`hive-mark${compact ? " compact" : ""}`} aria-hidden="true"><svg width={compact ? 20 : 24} height={compact ? 20 : 24} viewBox="0 0 24 24" fill="none"><path d="m12 2.8 7.7 4.5v9L12 20.8l-7.7-4.5v-9L12 2.8Z" stroke="currentColor" strokeWidth="1.7" /><circle cx="12" cy="12" r="3.2" fill="currentColor" /><path d="M12 5.2v3.1M17.7 8.6 15 10.1M17.7 15.4 15 13.9M6.3 15.4 9 13.9M6.3 8.6 9 10.1" stroke="var(--brand-contrast)" strokeWidth="1.1" /></svg></span>;
}
