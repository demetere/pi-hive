import { Match, Switch } from "solid-js";
import Kpis from "../components/Kpis";
import Widget from "../components/WidgetModal";
import TopologyGraph from "../components/TopologyGraph";
import LiveActivity from "../components/LiveActivity";
import CostTokensChart from "../components/CostTokensChart";
import ModelMix from "../components/ModelMix";
import ProjectsLeaderboard from "../components/ProjectsLeaderboard";
import SessionsCards from "../components/SessionsCards";
import { currentSession, scope } from "../store";
import { projectName, sessionSlug } from "../lib/format";

export default function Overview() {
  const level = () => scope().level;

  // The hero widget changes by scope: fleet=projects, project=sessions,
  // session=topology. Topology only exists when there is exactly one topology.
  const heroTitle = () => level() === "fleet" ? "Projects" : level() === "project" ? "Sessions" : "Agent topology";
  const topoLabel = () => {
    const s = currentSession();
    return s ? `${projectName(s.cwd)} · ${sessionSlug(s.session_id)}` : "";
  };

  return (
    <>
      <Kpis />
      <div class="widgets">
        <Widget title={heroTitle()} class="span2 hero" sub={level() === "session" ? <small class="dim">{topoLabel()}</small> : undefined}>
          <Switch>
            <Match when={level() === "fleet"}><ProjectsLeaderboard /></Match>
            <Match when={level() === "project"}><SessionsCards /></Match>
            <Match when={level() === "session"}><TopologyGraph /></Match>
          </Switch>
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
