import { createSignal, For, Match, onMount, Show, Switch } from "solid-js";
import Sidebar from "./components/Sidebar";
import Topbar from "./components/Topbar";
import Overview from "./tabs/Overview";
import Sessions from "./tabs/Sessions";
import Agents from "./tabs/Agents";
import Activity from "./tabs/Activity";
import Cost from "./tabs/Cost";
import Plans from "./tabs/Plans";
import AgentLog from "./components/AgentLog";
import ConfirmModal from "./components/ConfirmModal";
import { activeTab, connect, now, scope, scopeTitle, scopedStats, selectFleet, selectProject } from "./store";
import { relTime, sessionSlug } from "./lib/format";

export default function App() {
  const [search, setSearch] = createSignal("");
  onMount(() => { connect(); });

  const sub = () => {
    const s = scope();
    const st = scopedStats();
    if (s.level === "fleet") return `${st.sessions} sessions across all projects · ${st.live} live · ${st.running} agents running`;
    if (s.level === "project") return `${st.sessions} session${st.sessions === 1 ? "" : "s"} · ${st.live} live · ${st.running} agents running`;
    const t = scopeTitle();
    const sess = (t as any).session;
    return sess ? `Session ${sessionSlug(sess.session_id)} · ${sess.live ? `${sess.running} agents running` : "idle"} · updated ${relTime(sess.last_ts, now())}` : "session";
  };

  // breadcrumb: clicking a crumb navigates up the scope.
  function clickCrumb(i: number) {
    const s = scope();
    if (i === 0) selectFleet();
    else if (i === 1 && (s.level === "project" || s.level === "session")) selectProject(s.project);
  }

  return (
    <div class="shell">
      <Sidebar />
      <div class="main">
        <Topbar search={search()} setSearch={setSearch} />
        <div class="content">
          <div class="content-head">
            <div>
              <div class="crumbs">
                <For each={scopeTitle().crumbs}>
                  {(c, i) => (
                    <>
                      <Show when={i() > 0}><span class="crumb-sep">›</span></Show>
                      <span class={`crumb ${i() === scopeTitle().crumbs.length - 1 ? "current" : "link"}`} onClick={() => i() < scopeTitle().crumbs.length - 1 && clickCrumb(i())}>{c}</span>
                    </>
                  )}
                </For>
              </div>
              <h1>{scopeTitle().title}</h1>
              <div class="ctx-sub">{sub()}</div>
            </div>
          </div>
          <Switch fallback={<Overview />}>
            <Match when={activeTab() === "overview"}><Overview /></Match>
            <Match when={activeTab() === "sessions"}><Sessions search={search()} /></Match>
            <Match when={activeTab() === "agents"}><Agents search={search()} /></Match>
            <Match when={activeTab() === "plans"}><Plans search={search()} /></Match>
            <Match when={activeTab() === "activity"}><Activity search={search()} /></Match>
            <Match when={activeTab() === "cost"}><Cost /></Match>
          </Switch>
        </div>
      </div>
      <AgentLog />
      <ConfirmModal />
    </div>
  );
}
