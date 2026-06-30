import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { hierarchy, tree, type HierarchyPointNode } from "d3-hierarchy";
import type { AgentRuntime, TopologyNode } from "../types";
import { agentStatus, currentSession, flattenTopology, viewAgent } from "../store";
import { fmtCost, fmtNum, shortModel, clip } from "../lib/format";
import "./graph.css";

const NODE_W = 184;
const NODE_H = 66;

// Collect every name that appears strictly BELOW the given node (its descendants).
function descendantNames(node: TopologyNode | undefined, into: Set<string>) {
  for (const c of node?.children || []) { into.add(c.name); descendantNames(c, into); }
}

// Merge orchestrator + top-level agents into a single rooted tree.
//
// Defensive against racing/partial live snapshots: an agent must appear in
// exactly ONE place in the rendered tree. d3-hierarchy corrupts its layout if
// the same name appears twice (a deep node gets a phantom copy at depth 0,
// which is what made a running leaf "jump" to the far left and detach). So we
// only promote a top-level `agents[]` entry to a root child if it is not
// already nested somewhere in the tree, and we de-duplicate by name.
function rootOf(topo: ReturnType<typeof currentSession> extends infer _ ? any : never): TopologyNode | null {
  const t = topo?.topology;
  if (!t) return null;
  const agents: TopologyNode[] = t.agents || [];
  if (!t.orchestrator) {
    if (agents.length === 1) return agents[0];
    return { name: "Hive", role: "orchestrator", children: dedupeByName(agents) } as TopologyNode;
  }
  const orchChildren = t.orchestrator.children || [];
  // names already present anywhere under the orchestrator's own children, or
  // nested inside any top-level agent's subtree.
  const placed = new Set<string>(orchChildren.map((c: TopologyNode) => c.name));
  descendantNames({ name: "", children: orchChildren }, placed);
  for (const a of agents) descendantNames(a, placed);
  const extraRoots = agents.filter((a) => !placed.has(a.name));
  return { ...t.orchestrator, children: dedupeByName([...orchChildren, ...extraRoots]) };
}

function dedupeByName(nodes: TopologyNode[]): TopologyNode[] {
  const seen = new Set<string>();
  const out: TopologyNode[] = [];
  for (const n of nodes) { if (!seen.has(n.name)) { seen.add(n.name); out.push(n); } }
  return out;
}

export default function TopologyGraph() {
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
  const [view, setView] = createSignal({ k: 1, x: 0, y: 0 });
  let svgRef: SVGSVGElement | undefined;
  let pan: { x: number; y: number; vx: number; vy: number } | null = null;

  const session = currentSession;

  // Structural signature: the layout (node positions) depends ONLY on the tree
  // shape + which subtrees are collapsed — never on status/tokens/cost. Keying
  // the layout memo on this means a live status tick does NOT recompute d3
  // positions, so nodes never shift or jump while the hive runs.
  const structureKey = createMemo(() => {
    const root = rootOf(session());
    if (!root) return "∅";
    const sig: string[] = [];
    const walk = (n: TopologyNode, depth: number) => {
      sig.push(depth + ":" + n.name + (collapsed().has(n.name) ? "*" : ""));
      if (!collapsed().has(n.name)) for (const c of n.children || []) walk(c, depth + 1);
    };
    walk(root, 0);
    return sig.join("|");
  });

  // Positions: recomputed ONLY when structureKey changes (tree shape/collapse),
  // so live status ticks never reposition nodes.
  const layout = createMemo(() => {
    structureKey();
    const root = rootOf(session());
    if (!root) return null;
    const col = collapsed();
    // Global de-dup: each agent name is expanded at most once across the whole
    // tree, so a duplicated name from a partial snapshot can never spawn a
    // second (detached) copy in the d3 layout.
    const visited = new Set<string>([root.name]);
    const h = hierarchy(root, (d) => {
      if (col.has(d.name)) return null;
      return (d.children || []).filter((c) => { if (visited.has(c.name)) return false; visited.add(c.name); return true; });
    });
    const layoutTree = tree<TopologyNode>().nodeSize([NODE_W + 34, NODE_H + 58]);
    const laidOut = layoutTree(h);
    const nodes = laidOut.descendants();
    const links = laidOut.links();
    const xs = nodes.map((n) => n.x);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const maxY = Math.max(...nodes.map((n) => n.y));
    return {
      nodes, links,
      width: (maxX - minX) + NODE_W + 80,
      height: maxY + NODE_H + 60,
      ox: -minX + NODE_W / 2 + 24,
    };
  });

  // Live runtime data (status/tokens/cost), read separately so it updates
  // without touching positions.
  const agentsMap = createMemo(() => session()?.agents || new Map<string, AgentRuntime>());

  function statusOf(name: string): string {
    const sid = session()?.session_id || "";
    return agentStatus(sid, name, agentsMap().get(name)?.status);
  }

  function fit(attempt = 0) {
    const lo = layout(); if (!lo || !svgRef) return;
    const box = svgRef.getBoundingClientRect();
    // During mount the SVG may not be measured yet; retry on the next frame.
    if ((box.width < 10 || box.height < 10) && attempt < 20) {
      requestAnimationFrame(() => fit(attempt + 1));
      return;
    }
    const k = Math.max(0.35, Math.min(1.1, (box.width - 48) / lo.width, (box.height - 48) / lo.height));
    // Center the fitted tree both horizontally and vertically in the panel.
    setView({ k, x: (box.width - lo.width * k) / 2, y: Math.max(18, (box.height - lo.height * k) / 2) });
  }

  // Auto-fit on first paint and when the SESSION changes or the underlying
  // topology gains/loses agents from DATA — but NOT when the user collapses a
  // subtree (that's a deliberate view action; recentering on it is jarring) and
  // NOT on status/token ticks. So the fit key is derived from the full topology
  // (ignoring the collapsed set), not the laid-out (post-collapse) nodes.
  const fitKey = createMemo(() => {
    const sess = currentSession();
    const names = (flattenTopology(sess?.topology) || []).map((n: any) => n.name).join(",");
    return (sess?.session_id || "") + "|" + names;
  });
  onMount(() => {
    fit();
    // Re-fit when the container resizes (e.g. expanded into the modal, or the
    // window changes). Debounced via rAF inside fit()'s retry guard.
    if (svgRef && "ResizeObserver" in window) {
      let last = 0;
      const ro = new ResizeObserver((entries) => {
        const w = entries[0]?.contentRect.width || 0;
        if (Math.abs(w - last) > 8) { last = w; fit(); }
      });
      ro.observe(svgRef);
      onCleanup(() => ro.disconnect());
    }
  });
  createEffect(on(fitKey, () => fit(), { defer: false }));

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const v = view();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const k = Math.max(0.25, Math.min(2.5, v.k * factor));
    const rect = svgRef!.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    // zoom toward cursor
    setView({ k, x: mx - (mx - v.x) * (k / v.k), y: my - (my - v.y) * (k / v.k) });
  }
  // Pan is armed on pointerdown but does NOT capture the pointer yet — capturing
  // immediately would swallow clicks on nodes (so the log modal never opened).
  // We only begin actually panning (and capturing) once the pointer moves past a
  // small threshold; a down+up with no movement stays a click and reaches the
  // node's onClick.
  let panMoved = false;
  function onDown(e: PointerEvent) {
    const v = view();
    pan = { x: e.clientX, y: e.clientY, vx: v.x, vy: v.y };
    panMoved = false;
  }
  function onMove(e: PointerEvent) {
    if (!pan) return;
    const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
    if (!panMoved && Math.hypot(dx, dy) < 4) return; // below threshold → still a potential click
    if (!panMoved) { panMoved = true; try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* */ } }
    setView({ ...view(), x: pan.vx + dx, y: pan.vy + dy });
  }
  function onUp() { pan = null; panMoved = false; }

  function toggle(name: string, hasChildren: boolean) {
    if (!hasChildren) return;
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  }

  // elbow path between parent bottom and child top
  function edgePath(l: { source: HierarchyPointNode<TopologyNode>; target: HierarchyPointNode<TopologyNode>; }, ox: number) {
    const x1 = l.source.x + ox, y1 = l.source.y + NODE_H, x2 = l.target.x + ox, y2 = l.target.y;
    const my = y1 + (y2 - y1) / 2;
    return `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
  }

  return (
    <div class="graph-wrap" onWheel={onWheel}>
      <div class="graph-controls">
        <button onClick={() => setView((v) => ({ ...v, k: Math.min(2.5, v.k * 1.15) }))} title="Zoom in">+</button>
        <button onClick={() => setView((v) => ({ ...v, k: Math.max(0.25, v.k / 1.15) }))} title="Zoom out">−</button>
        <button onClick={() => fit()} title="Fit to view">⤢</button>
      </div>
      <Show when={layout()} fallback={<div class="g-empty">No topology yet. Start a hive session so it emits session_start.</div>}>
        {(lo) => (
          <svg
            ref={svgRef}
            class="graph-svg"
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}
            style={{ cursor: pan ? "grabbing" : "grab" }}
          >
            <g transform={`translate(${view().x},${view().y}) scale(${view().k})`}>
              <For each={lo().links}>
                {(l) => (
                  <path
                    class={`g-edge ${statusOf(l.target.data.name) === "running" ? "running" : ""}`}
                    d={edgePath(l, lo().ox)}
                  />
                )}
              </For>
              <For each={lo().nodes}>
                {(n) => {
                  const data = n.data;
                  const rt = () => agentsMap().get(data.name);
                  const status = () => statusOf(data.name);
                  const tokens = () => (rt()?.inputTokens || 0) + (rt()?.outputTokens || 0);
                  const hasKids = (data.children?.length || 0) > 0;
                  const isCollapsed = () => collapsed().has(data.name);
                  const openLog = (ev: MouseEvent) => {
                    ev.stopPropagation();
                    const sid = currentSession()?.session_id;
                    if (sid) viewAgent({ sessionId: sid, name: data.name, color: data.color, status: status(), model: data.model });
                  };
                  return (
                    <g
                      class={`g-node clickable ${status()}`}
                      transform={`translate(${n.x + lo().ox - NODE_W / 2},${n.y})`}
                      style={{ "--nc": data.color || "var(--accent)" } as any}
                      onClick={openLog}
                    >
                      <rect class="g-bg" rx="12" width={NODE_W} height={NODE_H} />
                      <Show when={status() === "running"}><circle class="g-dot-halo" cx="19" cy="20" r="4.5" /></Show>
                      <circle class={`g-dot ${status()}`} cx="19" cy="20" r="4.5" />
                      <text class="g-title" x="32" y="24">{clip(data.name, hasKids ? 17 : 19)}</text>
                      <text class="g-sub" x="16" y="43">{status()} · {fmtNum(tokens())} tok · {fmtCost(rt()?.costUsd || 0)}</text>
                      <text class="g-sub dim" x="16" y="56">{clip(shortModel(data.model), 22)} · {data.role || "member"}</text>
                      <Show when={hasKids}>
                        {/* Collapse toggle, kept fully inside the box (clear of
                            the rounded border) with a generous hit area. */}
                        <g class="g-collapse" transform={`translate(${NODE_W - 26},6)`}
                           onClick={(ev) => { ev.stopPropagation(); toggle(data.name, hasKids); }}
                           onPointerDown={(ev) => ev.stopPropagation()}>
                          <rect class="g-collapse-hit" x="-2" y="-2" width="24" height="24" rx="6" />
                          <circle r="9" cx="9" cy="9" />
                          <text x="9" y="13" text-anchor="middle">{isCollapsed() ? "+" : "−"}</text>
                        </g>
                      </Show>
                    </g>
                  );
                }}
              </For>
            </g>
          </svg>
        )}
      </Show>
    </div>
  );
}
