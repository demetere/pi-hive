import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hierarchy, tree, type HierarchyPointNode } from "d3-hierarchy";
import type { AgentRuntime, SessionView, Topology, TopologyNode } from "../types";
import { useHive } from "../store";
import { viewAgent } from "../store/raw";
import { usePanZoom } from "../hooks/usePanZoom";
import { fmtCost, fmtNum, shortModel, clip } from "../lib/format";

const NODE_W = 184;
const NODE_H = 66;

type TopologyKind = "active" | "hive" | "planning";

function pickTopology(sess: SessionView | undefined, kind: TopologyKind): Topology | undefined {
  if (!sess) return undefined;
  if (kind === "active") return sess.topology;
  const teamTopo = kind === "hive" ? sess.topologies?.hive : sess.topologies?.planning;
  if (teamTopo) return teamTopo;
  if (!sess.topologies && kind === "hive") return sess.topology;
  return sess.topologies?.active === kind ? sess.topology : undefined;
}

function descendantNames(node: TopologyNode | undefined, into: Set<string>) {
  for (const c of node?.children || []) { into.add(c.name); descendantNames(c, into); }
}

function rootOf(t: Topology | undefined): TopologyNode | null {
  if (!t) return null;
  const agents: TopologyNode[] = t.agents || [];
  if (!t.orchestrator) {
    if (agents.length === 1) return agents[0];
    return { name: "Hive", role: "orchestrator", children: dedupeByName(agents) } as TopologyNode;
  }
  const orchChildren = t.orchestrator.children || [];
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

// elbow path between parent bottom and child top
function edgePath(l: { source: HierarchyPointNode<TopologyNode>; target: HierarchyPointNode<TopologyNode>; }, ox: number) {
  const x1 = l.source.x + ox, y1 = l.source.y + NODE_H, x2 = l.target.x + ox, y2 = l.target.y;
  const my = y1 + (y2 - y1) / 2;
  return `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
}

export default function TopologyGraph(props: { kind?: TopologyKind }) {
  const session = useHive((s) => s.currentSession);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const svgRef = useRef<SVGSVGElement | null>(null);
  const { view, setView, grabbing, handlers } = usePanZoom(svgRef);

  const kind = props.kind || "active";
  const topology = useMemo(() => pickTopology(session, kind), [session, kind]);

  // Structural signature: the layout depends ONLY on the tree shape + which
  // subtrees are collapsed — never on status/tokens/cost. Keying the layout memo
  // on this means a live status tick does NOT recompute d3 positions.
  const structureKey = useMemo(() => {
    const root = rootOf(topology);
    if (!root) return "∅";
    const sig: string[] = [];
    const walk = (n: TopologyNode, depth: number) => {
      sig.push(depth + ":" + n.name + (collapsed.has(n.name) ? "*" : ""));
      if (!collapsed.has(n.name)) for (const c of n.children || []) walk(c, depth + 1);
    };
    walk(root, 0);
    return sig.join("|");
  }, [topology, collapsed]);

  const layout = useMemo(() => {
    const root = rootOf(topology);
    if (!root) return null;
    const col = collapsed;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey]);

  const agentsMap = session?.agents || new Map<string, AgentRuntime>();

  // When viewing a configured but inactive team, do not project the live
  // event-status overlay onto it.
  const inactiveTeam = !!(session?.topologies && kind !== "active" && session.topologies.active !== kind);

  const fit = useCallback((attempt = 0) => {
    const lo = layout; if (!lo || !svgRef.current) return;
    const box = svgRef.current.getBoundingClientRect();
    if ((box.width < 10 || box.height < 10) && attempt < 20) {
      requestAnimationFrame(() => fit(attempt + 1));
      return;
    }
    const k = Math.max(0.35, Math.min(1.1, (box.width - 48) / lo.width, (box.height - 48) / lo.height));
    setView({ k, x: (box.width - lo.width * k) / 2, y: Math.max(18, (box.height - lo.height * k) / 2) });
  }, [layout, setView]);

  // Auto-fit on data change (session/team/agent set), not on collapse.
  const fitKey = useMemo(() => {
    const names = layout ? layout.nodes.map((n) => n.data.name).join(",") : "";
    return (session?.session_id || "") + "|" + kind + "|" + names;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.session_id, kind, structureKey]);

  useEffect(() => { fit(); }, [fitKey, fit]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !("ResizeObserver" in window)) return;
    let last = 0;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width || 0;
      if (Math.abs(w - last) > 8) { last = w; fit(); }
    });
    ro.observe(svg);
    return () => ro.disconnect();
  }, [fit]);

  function toggle(name: string, hasChildren: boolean) {
    if (!hasChildren) return;
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  const emptyText = kind === "planning"
    ? "No planning topology yet. Add a planning team and start a hive session."
    : "No topology yet. Start a hive session so it emits session_start.";

  return (
    <div className="graph-wrap">
      <div className="graph-controls">
        <button onClick={() => setView((v) => ({ ...v, k: Math.min(2.5, v.k * 1.15) }))} title="Zoom in">+</button>
        <button onClick={() => setView((v) => ({ ...v, k: Math.max(0.25, v.k / 1.15) }))} title="Zoom out">−</button>
        <button onClick={() => fit()} title="Fit to view">⤢</button>
      </div>
      {!layout ? <div className="g-empty">{emptyText}</div> : (
        <svg
          ref={svgRef}
          className="graph-svg"
          {...handlers}
          style={{ cursor: grabbing ? "grabbing" : "grab" }}
        >
          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {layout.links.map((l) => (
              <EdgeLine key={l.target.data.name} link={l} ox={layout.ox} sessionId={session?.session_id || ""} inactiveTeam={inactiveTeam} snapStatus={agentsMap.get(l.target.data.name)?.status} />
            ))}
            {layout.nodes.map((n) => (
              <Node
                key={n.data.name}
                node={n}
                ox={layout.ox}
                sessionId={session?.session_id || ""}
                inactiveTeam={inactiveTeam}
                rt={agentsMap.get(n.data.name)}
                collapsed={collapsed.has(n.data.name)}
                onToggle={toggle}
              />
            ))}
          </g>
        </svg>
      )}
    </div>
  );
}

// Each edge/node subscribes to its own agent status so a status change repaints
// just that element — positions (from the memoized layout) stay untouched.
function useStatus(sessionId: string, name: string, inactiveTeam: boolean, snapStatus?: string): string {
  const evStatus = useHive((s) => s.eventStatus.get(sessionId)?.get(name));
  if (inactiveTeam) return "idle";
  return evStatus || snapStatus || "idle";
}

function EdgeLine(props: { link: any; ox: number; sessionId: string; inactiveTeam: boolean; snapStatus?: string }) {
  const status = useStatus(props.sessionId, props.link.target.data.name, props.inactiveTeam, props.snapStatus);
  return <path className={`g-edge ${status === "running" ? "running" : ""}`} d={edgePath(props.link, props.ox)} />;
}

function Node(props: {
  node: HierarchyPointNode<TopologyNode>; ox: number; sessionId: string; inactiveTeam: boolean;
  rt?: AgentRuntime; collapsed: boolean; onToggle: (name: string, hasKids: boolean) => void;
}) {
  const { node, ox, rt } = props;
  const data = node.data;
  const status = useStatus(props.sessionId, data.name, props.inactiveTeam, rt?.status);
  const tokens = (rt?.inputTokens || 0) + (rt?.outputTokens || 0);
  const hasKids = (data.children?.length || 0) > 0;
  const nodeKind = data.agentType || data.role || "member";

  const openLog = () => {
    if (props.sessionId) viewAgent({ sessionId: props.sessionId, name: data.name, color: data.color, status, model: data.model });
  };
  const onClick = (ev: React.MouseEvent) => { ev.stopPropagation(); openLog(); };
  const onKeyDown = (ev: React.KeyboardEvent) => {
    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); openLog(); }
  };

  return (
    <g
      className={`g-node clickable ${status}`}
      transform={`translate(${node.x + ox - NODE_W / 2},${node.y})`}
      style={{ "--nc": data.color || "var(--accent)" } as React.CSSProperties}
      role="button"
      tabIndex={0}
      aria-label={`${data.name} — ${status}, ${fmtNum(tokens)} tokens, ${fmtCost(rt?.costUsd || 0)}. Open transcript.`}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <rect className="g-bg" rx="12" width={NODE_W} height={NODE_H} />
      {status === "running" && <circle className="g-dot-halo" cx="19" cy="20" r="4.5" />}
      <circle className={`g-dot ${status}`} cx="19" cy="20" r="4.5" />
      <text className="g-title" x="32" y="24">{clip(data.name, hasKids ? 17 : 19)}</text>
      <text className="g-sub" x="16" y="43">{status} · {fmtNum(tokens)} tok · {fmtCost(rt?.costUsd || 0)}</text>
      <text className="g-sub dim" x="16" y="56">{clip(shortModel(data.model), 18)} · {nodeKind}</text>
      {hasKids && (
        <g className="g-collapse" transform={`translate(${NODE_W - 26},6)`}
           onClick={(ev) => { ev.stopPropagation(); props.onToggle(data.name, hasKids); }}
           onPointerDown={(ev) => ev.stopPropagation()}>
          <rect className="g-collapse-hit" x="-2" y="-2" width="24" height="24" rx="6" />
          <circle r="9" cx="9" cy="9" />
          <text x="9" y="13" textAnchor="middle">{props.collapsed ? "+" : "−"}</text>
        </g>
      )}
    </g>
  );
}
