import { store, type HiveState } from "./index";
import type { Scope } from "./index";

// ── URL ⇆ state routing ──────────────────────────────────────────────────────
// The two pieces of navigation state that should survive a reload are the active
// tab and the current scope (fleet / project / session). We encode both into the
// path so a refresh or a shared link lands on the same view. The project drives
// the hierarchy: a session nests under its project, mirroring the breadcrumb
// (Overview › project › session).
//
//   /                                             → fleet · overview
//   /:tab                                         → fleet · :tab
//   /project/:project/:tab                        → project scope
//   /project/:project/session/:sessionId/:tab     → session scope (under project)
//
// Project names and session ids are URL-encoded. The server serves index.html
// for any of these paths (SPA history fallback), so deep links work.

const TABS = new Set(["overview", "sessions", "activity", "plans", "cost"]);

function normTab(tab: string | undefined): string {
  return tab && TABS.has(tab) ? tab : "overview";
}

export function pathFor(scope: Scope, tab: string): string {
  const t = normTab(tab);
  if (scope.level === "fleet") return t === "overview" ? "/" : `/${t}`;
  const proj = encodeURIComponent(scope.project);
  if (scope.level === "project") return `/project/${proj}/${t}`;
  return `/project/${proj}/session/${encodeURIComponent(scope.sessionId)}/${t}`;
}

export interface ParsedRoute { scope: Scope; activeTab: string; }

export function parsePath(pathname: string): ParsedRoute {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return { scope: { level: "fleet" }, activeTab: "overview" };

  if (parts[0] === "project" && parts[1]) {
    const project = parts[1];
    // /project/:project/session/:sessionId/:tab
    if (parts[2] === "session" && parts[3]) {
      return { scope: { level: "session", project, sessionId: parts[3] }, activeTab: normTab(parts[4]) };
    }
    // /project/:project/:tab
    return { scope: { level: "project", project }, activeTab: normTab(parts[2]) };
  }
  // /:tab (fleet scope)
  return { scope: { level: "fleet" }, activeTab: normTab(parts[0]) };
}

// Apply a parsed route to the store. Sets selectedSession when landing directly
// on a session URL so scoped derivations resolve to the right session.
function applyRoute(route: ParsedRoute) {
  const patch: Partial<HiveState> = { scope: route.scope, activeTab: route.activeTab };
  if (route.scope.level === "session") patch.selectedSession = route.scope.sessionId;
  store.setState(patch);
}

let installed = false;

// Wire the store's scope/tab to the URL and vice-versa. Idempotent so React 18
// StrictMode's double-invoke can't double-subscribe.
export function installRouter() {
  if (installed) return;
  installed = true;

  // 1. Seed state from the current URL before the first render settles.
  applyRoute(parsePath(window.location.pathname));

  // 2. Reflect scope/tab changes into the URL (pushState on real navigation).
  const sync = (s: HiveState) => {
    const next = pathFor(s.scope, s.activeTab);
    if (next === window.location.pathname) return;
    window.history.pushState(null, "", next);
  };
  store.subscribe((s) => s.scope, () => sync(store.getState()));
  store.subscribe((s) => s.activeTab, () => sync(store.getState()));

  // 3. Back/forward → update the store.
  window.addEventListener("popstate", () => {
    applyRoute(parsePath(window.location.pathname));
  });
}
