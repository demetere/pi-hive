import { lazy, Suspense, useState } from "react";
import Kpis from "../components/Kpis";
import Widget from "../components/WidgetModal";
import LiveActivity from "../components/LiveActivity";
import CostTokensChart from "../components/CostTokensChart";
import ModelMix from "../components/ModelMix";
import { useHive } from "../store";

// The topology graph pulls in d3-hierarchy; code-split it so that dependency
// only loads when the Overview tab (the sole consumer) actually renders.
const TopologyGraph = lazy(() => import("../components/TopologyGraph"));

// The four-color status legend shown on the topology header.
const LEGEND: { label: string; color: string }[] = [
  { label: "running", color: "var(--run)" },
  { label: "waiting", color: "var(--wait)" },
  { label: "done", color: "var(--done)" },
  { label: "error", color: "var(--crit)" },
];

function StatusLegend() {
  return (
    <div className="flex gap-[7px]">
      {LEGEND.map((l) => (
        <span key={l.label} className="flex items-center gap-1.5 text-[11px] text-ink-dim bg-well rounded-full pl-2 pr-2.5 py-1">
          <i className="w-[7px] h-[7px] rounded-full block" style={{ background: l.color }} />
          {l.label}
        </span>
      ))}
    </div>
  );
}

export default function Overview() {
  const [topologyView, setTopologyView] = useState<"hive" | "planning">("hive");
  const currentSession = useHive((s) => s.currentSession);
  const scopedAgents = useHive((s) => s.scopedAgents);
  const scope = useHive((s) => s.scope);

  const topoTitle = scope.level === "session" ? "Session topology" : "Agent Topology";

  const teamCount = scopedAgents.filter((a) => a.role === "lead").length;
  const topoMeta = `${teamCount} teams · ${scopedAgents.length} agents`;

  // First-run / empty state: no session has produced telemetry yet. Show a calm
  // in-language signature rather than a wall of empty panels.
  const isEmpty = !currentSession && scopedAgents.length === 0;
  if (isEmpty) {
    return (
      <div className="grid place-items-center py-24 text-center">
        <div className="flex flex-col items-center gap-5 max-w-[360px]">
          <div className="w-[72px] h-[72px] rounded-[20px] bg-brand-bg grid place-items-center animate-softblink">
            <svg width="40" height="40" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="9" fill="none" stroke="var(--brand)" strokeWidth="1.5" />
              <circle cx="12" cy="12" r="3.4" fill="var(--brand)" />
              <circle cx="12" cy="4.4" r="1.5" fill="var(--brand)" />
              <circle cx="19" cy="15.5" r="1.5" fill="var(--brand)" />
              <circle cx="5" cy="15.5" r="1.5" fill="var(--brand)" />
            </svg>
          </div>
          <div>
            <div className="text-[17px] font-bold tracking-[-.01em]">Waiting for hive telemetry</div>
            <p className="text-ink-dim text-[13px] leading-relaxed mt-2">
              Start a hive session in your project and this console lights up in real time — topology, activity, cost, and model mix.
            </p>
          </div>
          <code className="font-mono text-[11px] text-ink-dim bg-well border border-line rounded-lg px-3 py-2">pi · run a hive task</code>
        </div>
      </div>
    );
  }

  return (
    <>
      <Kpis />
      <div className="widgets">
        <Widget
          title={topoTitle}
          className="hero"
          sub={<span className="font-mono text-[11px] text-ink-dim ml-1">{topoMeta}</span>}
          headExtra={<StatusLegend />}
        >
          <div className="topology-pane single">
            <div className="topology-pane-head">
              <div className="topology-switch" role="tablist" aria-label="Topology team">
                <button className={topologyView === "hive" ? "active" : ""} onClick={() => setTopologyView("hive")}>Hive</button>
                <button className={topologyView === "planning" ? "active" : ""} onClick={() => setTopologyView("planning")}>Planning</button>
              </div>
              {currentSession?.live ? <b>live</b>
                : currentSession?.topologies?.active === topologyView ? <b>active</b> : null}
            </div>
            <Suspense fallback={<div className="g-empty">Loading topology…</div>}>
              <TopologyGraph kind={topologyView} />
            </Suspense>
          </div>
        </Widget>

        <Widget
          title="Activity"
          className="hero"
          headExtra={
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-run">
              <span className="w-[6px] h-[6px] rounded-full bg-run animate-softblink-fast" />streaming
            </span>
          }
        >
          <LiveActivity limit={40} />
        </Widget>

        <Widget
          title="Cost & Tokens"
          sub={<span className="font-medium text-ink-dim text-xs ml-1">· last 60 min</span>}
          headExtra={
            <span className="w-legend">
              <span className="lg-item"><i className="lg cost" />cost/min</span>
              <span className="lg-item"><i className="lg tok" />tokens/min</span>
            </span>
          }
        >
          <CostTokensChart mode="rate" />
        </Widget>

        <Widget title="Model Mix">
          <ModelMix />
        </Widget>
      </div>
    </>
  );
}
