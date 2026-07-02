import { useEffect, useState } from "react";
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
import { useHive } from "./store";
import { selectFleet, selectProject } from "./store/raw";
import { connect } from "./store/wiring";
import { relTime, sessionSlug } from "./lib/format";

// Scope subtitle. Isolated into its own leaf so the 1s `now` tick (needed only
// for the "updated Xs ago" clause at session scope) re-renders this line alone,
// not the whole tab tree.
function ScopeSubtitle() {
  const scope = useHive((s) => s.scope);
  const scopeTitle = useHive((s) => s.scopeTitle);
  const scopedStats = useHive((s) => s.scopedStats);
  const now = useHive((s) => s.now);

  const s = scope;
  const st = scopedStats;
  let text: string;
  if (s.level === "fleet") text = `${st.sessions} sessions across all projects · ${st.live} live · ${st.running} agents running`;
  else if (s.level === "project") text = `${st.sessions} session${st.sessions === 1 ? "" : "s"} · ${st.live} live · ${st.running} agents running`;
  else {
    const sess = scopeTitle.session;
    text = sess ? `Session ${sessionSlug(sess.session_id)} · ${sess.live ? `${sess.running} agents running` : "idle"} · updated ${relTime(sess.last_ts, now || Date.now())}` : "session";
  }
  return <div className="text-muted text-xs mt-1">{text}</div>;
}

export default function App() {
  const [search, setSearch] = useState("");
  const activeTab = useHive((s) => s.activeTab);
  const scope = useHive((s) => s.scope);
  const scopeTitle = useHive((s) => s.scopeTitle);

  useEffect(() => { connect(); }, []);

  // breadcrumb: clicking a crumb navigates up the scope.
  function clickCrumb(i: number) {
    const s = scope;
    if (i === 0) selectFleet();
    else if (i === 1 && (s.level === "project" || s.level === "session")) selectProject(s.project);
  }

  const crumbs = scopeTitle.crumbs;

  return (
    <div className="grid grid-cols-[260px_1fr] h-screen p-3 gap-3 overflow-hidden">
      <Sidebar />
      <div className="flex flex-col min-w-0 min-h-0 overflow-hidden">
        <Topbar search={search} setSearch={setSearch} />
        <div className="flex-1 min-h-0 overflow-auto pt-3.5 px-0.5 pb-6">
          <div className="flex items-end justify-between gap-3 mb-4">
            <div>
              <div className="flex items-center gap-[7px] text-xs mb-1.5">
                {crumbs.map((c, i) => {
                  const last = i === crumbs.length - 1;
                  return (
                    <span key={i} className="contents">
                      {i > 0 && <span className="text-muted opacity-60">›</span>}
                      {last ? (
                        <span className="text-fg2 font-semibold">{c}</span>
                      ) : (
                        <button
                          type="button"
                          className="text-muted cursor-pointer hover:text-accent bg-transparent border-0 p-0"
                          style={{ font: "inherit" }}
                          onClick={() => clickCrumb(i)}
                        >{c}</button>
                      )}
                    </span>
                  );
                })}
              </div>
              <h1 className="m-0 text-[21px] font-bold tracking-[-.2px]">{scopeTitle.title}</h1>
              <ScopeSubtitle />
            </div>
          </div>
          {activeTab === "sessions" ? <Sessions search={search} />
            : activeTab === "agents" ? <Agents search={search} />
            : activeTab === "plans" ? <Plans search={search} />
            : activeTab === "activity" ? <Activity search={search} />
            : activeTab === "cost" ? <Cost />
            : <Overview />}
        </div>
      </div>
      <AgentLog />
      <ConfirmModal />
    </div>
  );
}
