import { useEffect } from "react";
import Sidebar from "./components/Sidebar";
import Topbar from "./components/Topbar";
import Overview from "./tabs/Overview";
import Sessions from "./tabs/Sessions";
import Agents from "./tabs/Agents";
import Activity from "./tabs/Activity";
import Cost from "./tabs/Cost";
import Plans from "./tabs/Plans";
import Settings from "./tabs/Settings";
import AgentLog from "./components/AgentLog";
import ConfirmModal from "./components/ConfirmModal";
import Toast from "./components/Toast";
import { useHive } from "./store";
import { selectProject, setActiveTab } from "./store/raw";
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
  return <div className="text-ink-dim text-xs mt-1">{text}</div>;
}

export default function App() {
  const activeTab = useHive((s) => s.activeTab);
  const scope = useHive((s) => s.scope);
  const scopeTitle = useHive((s) => s.scopeTitle);

  useEffect(() => { connect(); }, []);

  // Settings is project-scoped: if the user drops to fleet scope while on the
  // Settings tab, send them back to Overview so they aren't on a hidden tab.
  useEffect(() => {
    if (activeTab === "settings" && scope.level === "fleet") setActiveTab("overview");
  }, [activeTab, scope.level]);

  return (
    <div className="flex h-screen p-3 gap-3 overflow-hidden bg-bg text-ink">
      <Sidebar />
      <main className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden">
        <Topbar />
        <div className="flex-1 min-h-0 overflow-auto pt-3.5 px-0.5 pb-10">
          <div className="flex items-end justify-between gap-3 mb-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <h1 className="m-0 text-[21px] font-bold tracking-[-.015em]">{scopeTitle.title}</h1>
                {scope.level === "session" && (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 bg-brand-bg text-brand rounded-full pl-2.5 pr-2 py-1 text-[11px] font-semibold cursor-pointer border-0 hover:brightness-110"
                    title="Back to project — clear session filter"
                    onClick={() => selectProject((scope as { project: string }).project)}
                  >
                    <span className="w-[6px] h-[6px] rounded-full bg-brand" />
                    session {sessionSlug((scope as { sessionId: string }).sessionId)}
                    <span className="text-brand/70 text-[13px] leading-none ml-0.5">×</span>
                  </button>
                )}
              </div>
              <ScopeSubtitle />
            </div>
          </div>
          {activeTab === "sessions" ? <Sessions search="" />
            : activeTab === "agents" ? <Agents search="" />
            : activeTab === "plans" ? <Plans search="" />
            : activeTab === "activity" ? <Activity search="" />
            : activeTab === "cost" ? <Cost />
            : activeTab === "settings" ? (scope.level !== "fleet" ? <Settings /> : <Overview />)
            : <Overview />}
        </div>
      </main>
      <AgentLog />
      <ConfirmModal />
      <Toast />
    </div>
  );
}
