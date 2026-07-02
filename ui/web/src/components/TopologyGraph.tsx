import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hierarchy, tree, type HierarchyPointNode } from "d3-hierarchy";
import type { AgentRuntime, SessionView, Topology, TopologyNode } from "../types";
import { useHive } from "../store";
import { viewAgent } from "../store/raw";
import { usePanZoom } from "../hooks/usePanZoom";
import { fmtNum, clip } from "../lib/format";
import { ctxColor, modelTag, statusKey, thinkBars, thinkLevel, thinkName, tokPerSec } from "../lib/agents";

const NODE_H = 92;
// Card width adapts to content so full agent names + model tags fit without
// cropping. Computed per-tree from the widest name+badge, clamped to a range.
const NODE_W_MIN = 188;
const NODE_W_MAX = 340;

// Width the model pill needs for its tag text (≈5.4px/char at 8px mono + pad).
function tagWidth(tag: string): number {
  return Math.min(120, Math.max(22, tag.length * 5.4 + 12));
}
// Width a node needs to show its full id + model badge on row 1:
//   left pad(12) + dot(~15) + id text + gap(8) + badge + right pad(12)
function nodeWidthFor(name: string, tag: string): number {
  const idW = name.length * 6.7;
  return 12 + 15 + idW + 8 + tagWidth(tag) + 12;
}

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
      // include model so card width (which depends on the model tag) recomputes
      sig.push(depth + ":" + n.name + "@" + (n.model || "") + (collapsed.has(n.name) ? "*" : ""));
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
    // First pass over the visible nodes to size all cards to the widest content,
    // so no name/model gets cropped and every card stays a uniform width.
    const probe = hierarchy(root, (d) => {
      if (col.has(d.name)) return null;
      return (d.children || []);
    });
    let needed = NODE_W_MIN;
    for (const n of probe.descendants()) {
      const d = n.data;
      needed = Math.max(needed, nodeWidthFor(d.name, modelTag(d.model)));
    }
    const nodeW = Math.min(NODE_W_MAX, Math.ceil(needed));

    const layoutTree = tree<TopologyNode>().nodeSize([nodeW + 44, NODE_H + 62]);
    const laidOut = layoutTree(h);
    const nodes = laidOut.descendants();
    const links = laidOut.links();
    const xs = nodes.map((n) => n.x);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const maxY = Math.max(...nodes.map((n) => n.y));
    return {
      nodes, links, nodeW,
      width: (maxX - minX) + nodeW + 80,
      height: maxY + NODE_H + 60,
      ox: -minX + nodeW / 2 + 24,
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
          <defs>
            <pattern id="topo-dots" width="26" height="26" patternUnits="userSpaceOnUse" patternTransform={`translate(${view.x},${view.y}) scale(${view.k})`}>
              <circle cx="1.5" cy="1.5" r="1.1" className="g-dotgrid" />
            </pattern>
          </defs>
          <rect x="0" y="0" width="100%" height="100%" fill="url(#topo-dots)" />
          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {layout.links.map((l) => (
              <EdgeLine key={l.target.data.name} link={l} ox={layout.ox} sessionId={session?.session_id || ""} inactiveTeam={inactiveTeam} snapStatus={agentsMap.get(l.target.data.name)?.status} />
            ))}
            {layout.nodes.map((n) => (
              <Node
                key={n.data.name}
                node={n}
                ox={layout.ox}
                nodeW={layout.nodeW}
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

// A short-height bar dial for reasoning effort, drawn as SVG rects that ascend
// left→right; filled up to the current level. Rendered inside the node card.
function ThinkDial({ x, y, model, level, tier }: { x: number; y: number; model?: string; level: number; tier: "lead" | "worker" }) {
  const bars = thinkBars(model, level, tier);
  const gap = tier === "lead" ? 2 : 1.2;
  const maxH = tier === "lead" ? 9 : 7;
  let cx = x;
  return (
    <g>
      {bars.map((b, i) => {
        const bx = cx; cx += b.w + gap;
        return <rect key={i} x={bx} y={y + (maxH - b.h)} width={b.w} height={b.h} rx="1" className={b.on ? "g-bar-on" : "g-bar-off"} />;
      })}
    </g>
  );
}

function Node(props: {
  node: HierarchyPointNode<TopologyNode>; ox: number; nodeW: number; sessionId: string; inactiveTeam: boolean;
  rt?: AgentRuntime; collapsed: boolean; onToggle: (name: string, hasKids: boolean) => void;
}) {
  const { node, ox, rt } = props;
  const data = node.data;
  const status = useStatus(props.sessionId, data.name, props.inactiveTeam, rt?.status);
  const sk = statusKey(status);
  const tokens = (rt?.inputTokens || 0) + (rt?.outputTokens || 0);
  const hasKids = (data.children?.length || 0) > 0;
  const role = data.agentType || data.role || "member";
  const isOrchestrator = role === "orchestrator";
  const isLead = isOrchestrator || role === "lead" || hasKids;
  const tier: "lead" | "worker" = isLead ? "lead" : "worker";

  const model = data.model || rt?.model;
  const ctxPct = Math.max(0, Math.min(100, Math.round(rt?.contextPct ?? 0)));
  const level = thinkLevel(model, rt?.thinking);
  const tps = tokPerSec(rt?.inputTokens, rt?.outputTokens, rt?.elapsedMs);

  const openLog = () => {
    if (props.sessionId) viewAgent({ sessionId: props.sessionId, name: data.name, color: data.color, status, model });
  };
  const onClick = (ev: React.MouseEvent) => { ev.stopPropagation(); openLog(); };
  const onKeyDown = (ev: React.KeyboardEvent) => {
    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); openLog(); }
  };

  const W = props.nodeW, H = NODE_H;
  const ctxCol = ctxColor(ctxPct);
  const tag = modelTag(model);
  const tagW = tagWidth(tag);
  // Agent identity color (every agent carries one). Used as a left accent so the
  // topology speaks the same per-agent color language as the activity feed and
  // leaderboard — distinct from the status dot, which stays the status signal.
  const agentColor = data.color || "var(--brand)";
  const safeName = data.name.replace(/[^a-z0-9]/gi, "");
  const clipId = `nclip-${safeName}`;
  const gradId = `nwash-${safeName}`;

  return (
    <g
      className={`g-node clickable ${sk} ${isOrchestrator ? "orchestrator" : isLead ? "lead" : "worker"}`}
      transform={`translate(${node.x + ox - W / 2},${node.y})`}
      role="button"
      tabIndex={0}
      aria-label={`${data.name} — ${status}, ${ctxPct}% context, ${fmtNum(tokens)} tokens. Open transcript.`}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <defs>
        <clipPath id={clipId}><rect rx="14" width={W} height={H} /></clipPath>
        {/* wash carries the full card width, fading left→right into transparent */}
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={agentColor} stopOpacity="0.14" />
          <stop offset="0.5" stopColor={agentColor} stopOpacity="0.05" />
          <stop offset="1" stopColor={agentColor} stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect className="g-bg" rx="14" width={W} height={H} />
      {/* identity accent: colored left edge + full-width wash, clipped to the card */}
      <g clipPath={`url(#${clipId})`}>
        <rect x="0" y="0" width={W} height={H} fill={`url(#${gradId})`} />
        <rect x="0" y="0" width="3" height={H} fill={agentColor} opacity="0.9" />
      </g>

      {/* Row 1: status dot + halo, id, model badge */}
      {sk === "running" && <circle className="g-dot-halo" cx="17" cy="19" r="4" />}
      <circle className={`g-dot ${sk}`} cx="17" cy="19" r="3.5" />
      {/* id gets the width left of the model pill; ~6.6px per char at 12px */}
      <text className="g-id" x="27" y="23" style={{ fontSize: 12 }}>{clip(data.name, Math.max(6, Math.floor((W - 12 - tagW - 27 - 6) / 6.6)))}</text>
      <g transform={`translate(${W - 12 - tagW},13)`}>
        <rect className="g-badge-bg" width={tagW} height="14" rx="7" />
        <text className="g-badge-tx" x={tagW / 2} y="10" textAnchor="middle" style={{ fontSize: 8, letterSpacing: ".02em" }}>{tag}</text>
      </g>

      {/* Row 2: CTX bar */}
      <text className="g-cap" x="12" y="45" style={{ fontSize: 7.5 }}>CTX</text>
      <rect x="32" y="40" width={W - 76} height="4" rx="2" className="g-ctx-track" />
      <rect x="32" y="40" width={(W - 76) * (ctxPct / 100)} height="4" rx="2" fill={ctxCol} />
      <text x={W - 12} y="45" textAnchor="end" className="g-val" style={{ fontSize: 8.5, fill: ctxCol }}>{ctxPct}%</text>

      {/* Row 3: THINK dial · TOK/S · TOTAL */}
      <text className="g-cap" x="12" y="63" style={{ fontSize: 7 }}>THINK</text>
      <ThinkDial x={12} y={66} model={model} level={level} tier={tier} />
      <text className="g-cap" x="12" y="84" style={{ fontSize: 6.5 }}>{thinkName(model, level).toUpperCase()}</text>

      <text className="g-cap" x={W / 2} y="63" textAnchor="middle" style={{ fontSize: 7 }}>TOK/S</text>
      <text className="g-val" x={W / 2} y="78" textAnchor="middle" style={{ fontSize: 10.5 }}>{tps ? Math.round(tps) : "—"}</text>

      <text className="g-cap" x={W - 12} y="63" textAnchor="end" style={{ fontSize: 7 }}>TOTAL</text>
      <text className="g-val" x={W - 12} y="78" textAnchor="end" style={{ fontSize: 10.5 }}>{fmtNum(tokens)}</text>

      {/* collapse toggle rides the bottom-center edge, between the card and its
          children — clear of the TOTAL/TOK-S/THINK stats. */}
      {hasKids && (
        <g className="g-collapse" transform={`translate(${W / 2 - 8},${H - 8})`}
           onClick={(ev) => { ev.stopPropagation(); props.onToggle(data.name, hasKids); }}
           onPointerDown={(ev) => ev.stopPropagation()}>
          <rect className="g-collapse-hit" x="-4" y="-4" width="24" height="24" rx="8" />
          <circle r="8" cx="8" cy="8" />
          <text x="8" y="12" textAnchor="middle">{props.collapsed ? "+" : "−"}</text>
        </g>
      )}
    </g>
  );
}
