import { lazy, Suspense, useState } from "react";
import Kpis from "../components/Kpis";
import Widget from "../components/WidgetModal";
import LiveActivity from "../components/LiveActivity";
import CostTokensChart from "../components/CostTokensChart";
import ModelMix from "../components/ModelMix";
import { useHive } from "../store";
import { projectName, sessionSlug } from "../lib/format";

// The topology graph pulls in d3-hierarchy; code-split it so that dependency
// only loads when the Overview tab (the sole consumer) actually renders.
const TopologyGraph = lazy(() => import("../components/TopologyGraph"));

export default function Overview() {
  const [topologyView, setTopologyView] = useState<"hive" | "planning">("hive");
  const currentSession = useHive((s) => s.currentSession);
  const scope = useHive((s) => s.scope);

  const topoTitle = scope.level === "session" ? "Session topology" : "Latest topology";
  const topoLabel = currentSession
    ? `${projectName(currentSession.cwd)} · ${sessionSlug(currentSession.session_id)}`
    : "Waiting for hive telemetry";

  return (
    <>
      <Kpis />
      <div className="widgets">
        <Widget title={topoTitle} className="span2 hero" sub={<small className="text-muted">{topoLabel}</small>}>
          <div className="topology-pane single">
            <div className="topology-pane-head">
              <div className="topology-switch" role="tablist" aria-label="Topology team">
                <button className={topologyView === "hive" ? "active" : ""} onClick={() => setTopologyView("hive")}>Hive execution</button>
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

        <Widget title="Live activity" className="hero" headExtra={<span className="w-2 h-2 rounded-full bg-ok animate-ping2" />}>
          <LiveActivity limit={40} />
        </Widget>

        <Widget title="Cost & tokens over time" className="span2"
          headExtra={<span className="w-legend"><i className="lg cost" />cost<i className="lg tok" />tokens</span>}>
          <CostTokensChart />
        </Widget>

        <Widget title="Model mix & leaders">
          <ModelMix />
        </Widget>
      </div>
    </>
  );
}
