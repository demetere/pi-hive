import { createSignal, Match, Switch } from "solid-js";
import Kpis from "../components/Kpis";
import Widget from "../components/WidgetModal";
import TopologyGraph from "../components/TopologyGraph";
import LiveActivity from "../components/LiveActivity";
import CostTokensChart from "../components/CostTokensChart";
import ModelMix from "../components/ModelMix";
import { currentSession, scope } from "../store";
import { projectName, sessionSlug } from "../lib/format";

export default function Overview() {
  const [topologyView, setTopologyView] = createSignal<"hive" | "planning">("hive");

  const topoTitle = () => scope().level === "session" ? "Session topology" : "Latest topology";
  const topoLabel = () => {
    const s = currentSession();
    return s ? `${projectName(s.cwd)} · ${sessionSlug(s.session_id)}` : "Waiting for hive telemetry";
  };

  return (
    <>
      <Kpis />
      <div class="widgets">
        <Widget title={topoTitle()} class="span2 hero" sub={<small class="dim">{topoLabel()}</small>}>
          <div class="topology-pane single">
            <div class="topology-pane-head">
              <div class="topology-switch" role="tablist" aria-label="Topology team">
                <button class={topologyView() === "hive" ? "active" : ""} onClick={() => setTopologyView("hive")}>Hive execution</button>
                <button class={topologyView() === "planning" ? "active" : ""} onClick={() => setTopologyView("planning")}>Planning</button>
              </div>
              <Switch>
                <Match when={currentSession()?.live}><b>live</b></Match>
                <Match when={currentSession()?.topologies?.active === topologyView()}><b>active</b></Match>
              </Switch>
            </div>
            <TopologyGraph kind={topologyView()} />
          </div>
        </Widget>

        <Widget title="Live activity" class="hero" headExtra={<span class="now-pip" />}>
          <LiveActivity limit={40} />
        </Widget>

        <Widget title="Cost & tokens over time" class="span2"
          headExtra={<span class="w-legend"><i class="lg cost" />cost<i class="lg tok" />tokens</span>}>
          <CostTokensChart />
        </Widget>

        <Widget title="Model mix & leaders">
          <ModelMix />
        </Widget>
      </div>
    </>
  );
}
