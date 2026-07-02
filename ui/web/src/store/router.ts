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

const TABS = new Set(["overview", "sessions", "activity", "plans", "cost", "settings"]);

function normTab(tab: string | undefined): string {
  return tab && TABS.has(tab) ? tab : "overview";
}

// The URL uses the project's DISPLAY label (its official name after a rename)
// when one exists, falling back to the derived name. `projectSlug` resolves the
// internal derived key → label; `resolveProject` reverses it when parsing.
function projectSlug(project: string): string {
  const groups = store.getState().projectGroups;
  const g = groups.find((x) => x.name === project);
  return g?.label || project;
}

// Given a URL project segment (which may be a label or the derived name), find
// the internal derived project key it refers to.
export function resolveProject(segment: string): string {
  const groups = store.getState().projectGroups;
  const byName = groups.find((x) => x.name === segment);
  if (byName) return byName.name;
  const byLabel = groups.find((x) => x.label === segment);
  return byLabel ? byLabel.name : segment;
}

export function pathFor(scope: Scope, tab: string): string {
  const t = normTab(tab);
  if (scope.level === "fleet") return t === "overview" ? "/" : `/${t}`;
  const proj = encodeURIComponent(projectSlug(scope.project));
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
  // The URL carries the project label; map it back to the internal derived key.
  let scope = route.scope;
  if (scope.level === "project") scope = { ...scope, project: resolveProject(scope.project) };
  else if (scope.level === "session") scope = { ...scope, project: resolveProject(scope.project) };
  const patch: Partial<HiveState> = { scope, activeTab: route.activeTab };
  if (scope.level === "session") patch.selectedSession = scope.sessionId;
  store.setState(patch);
}

let installed = false;

// Wire the store's scope/tab to the URL and vice-versa. Idempotent so React 18
// StrictMode's double-invoke can't double-subscribe.
export function installRouter() {
  if (installed) return;
  installed = true;

  // 1. Seed state from the current URL before the first render settles.
  const initialRoute = parsePath(window.location.pathname);
  applyRoute(initialRoute);

  // If a project deep-link used a label that isn't resolvable yet (groups load
  // async), re-resolve once the project groups arrive, then stop.
  if (initialRoute.scope.level !== "fleet") {
    const unresolvedSeg = (initialRoute.scope as any).project as string;
    const stop = store.subscribe((s) => s.projectGroups, (groups) => {
      if (!groups.length) return;
      const key = resolveProject(unresolvedSeg);
      const cur = store.getState().scope;
      if (cur.level !== "fleet" && cur.project !== key) {
        store.setState({ scope: { ...cur, project: key } as Scope });
      }
      stop();
    });
  }

  // 2. Reflect scope/tab/label changes into the URL (pushState on real navigation).
  const sync = (s: HiveState) => {
    const next = pathFor(s.scope, s.activeTab);
    if (next === window.location.pathname) return;
    window.history.pushState(null, "", next);
  };
  store.subscribe((s) => s.scope, () => sync(store.getState()));
  store.subscribe((s) => s.activeTab, () => sync(store.getState()));
  // A rename doesn't change scope but changes the label → refresh the URL.
  store.subscribe((s) => s.projectOverrides, () => sync(store.getState()));

  // 3. Back/forward → update the store.
  window.addEventListener("popstate", () => {
    applyRoute(parsePath(window.location.pathname));
  });
}
