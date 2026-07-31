import { hierarchy, tree, type HierarchyPointLink, type HierarchyPointNode } from "d3-hierarchy";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

type TopologyRecord = Readonly<Record<string, unknown>>;
interface GraphNode {
  readonly id: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly role?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly contextPct?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly elapsedMs?: number;
  readonly status: string;
  readonly color: string;
  readonly children: readonly GraphNode[];
  readonly synthetic?: boolean;
}
interface ViewState { readonly k: number; readonly x: number; readonly y: number }

const NODE_H = 92;
const NODE_W_MIN = 188;
const NODE_W_MAX = 340;
const THINK_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const COLORS = ["var(--brand)", "var(--run)", "var(--done)", "var(--warn)", "#a78bfa", "#f472b6"] as const;

function text(record: TopologyRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value ? value : undefined;
}
function statusClass(status: string): "running" | "done" | "waiting" | "error" | "idle" {
  const value = status.toLowerCase();
  if (/error|fail|blocked|cancel/u.test(value)) return "error";
  if (/complete|done|approved|ready|recorded|available|configured/u.test(value)) return "done";
  if (/run|active|current|started|progress/u.test(value)) return "running";
  if (/pending|wait|pause|question|human/u.test(value)) return "waiting";
  return "idle";
}
function numeric(record: TopologyRecord, key: string): number | undefined { const value = record[key]; return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function clip(value: string, length: number): string { return value.length <= length ? value : `${value.slice(0, Math.max(1, length - 1))}…`; }
function shortModel(model?: string): string { return model ? model.split("/").at(-1) || model : "inherit"; }
function modelTag(model?: string): string {
  let raw = shortModel(model).toLowerCase(); if (!raw || raw === "inherit") return "—";
  raw = raw.replace(/-?\d{6,8}$/u, "").replace(/^claude-/u, "").replace(/(opus|sonnet|haiku)-(\d+)-(\d+)/u, "$1-$2.$3"); return raw;
}
function tagWidth(value: string): number { return Math.min(120, Math.max(22, value.length * 5.4 + 12)); }
function nodeWidthFor(node: GraphNode): number { return 12 + 15 + node.agentName.length * 6.7 + 8 + tagWidth(modelTag(node.model)) + 12; }
function normalizeThinking(value?: string): string { const raw = value?.trim().toLowerCase() ?? "off"; return ({ med: "medium", max: "xhigh", maximum: "xhigh", none: "off", mid: "medium" } as Record<string, string>)[raw] ?? raw; }
function thinkingLevel(value?: string): number { const index = THINK_ORDER.indexOf(normalizeThinking(value) as (typeof THINK_ORDER)[number]); return index < 0 ? 0 : index; }
function formatNumber(value: number): string { if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`; if (value >= 1000) return `${(value / 1000).toFixed(value >= 100000 ? 0 : 1)}k`; return String(Math.round(value)); }
function contextColor(value: number): string { return value > 85 ? "var(--crit)" : value > 60 ? "var(--warn)" : "var(--ink-dim)"; }
function edgePath(link: HierarchyPointLink<GraphNode>, offsetX: number): string {
  const x1 = link.source.x + offsetX; const y1 = link.source.y + NODE_H; const x2 = link.target.x + offsetX; const y2 = link.target.y; const middle = y1 + (y2 - y1) / 2;
  return `M ${x1} ${y1} C ${x1} ${middle}, ${x2} ${middle}, ${x2} ${y2}`;
}
function graphForest(items: readonly TopologyRecord[]): GraphNode | undefined {
  const source = new Map<string, TopologyRecord>();
  for (const item of items) { const id = text(item, "nodeId"); if (id && !source.has(id)) source.set(id, item); }
  if (!source.size) return undefined;
  const children = new Map<string, string[]>(); const roots: string[] = [];
  for (const [id, item] of source) {
    const parent = text(item, "parentNodeId");
    if (!parent || parent === id || !source.has(parent)) roots.push(id);
    else children.set(parent, [...(children.get(parent) ?? []), id]);
  }
  const placed = new Set<string>();
  const build = (id: string, path: ReadonlySet<string>): GraphNode | undefined => {
    if (placed.has(id) || path.has(id)) return undefined;
    placed.add(id); const item = source.get(id)!; const nextPath = new Set(path); nextPath.add(id);
    const nested = (children.get(id) ?? []).flatMap((child) => { const node = build(child, nextPath); return node ? [node] : []; });
    const index = [...source.keys()].indexOf(id);
    const agentId = text(item, "agentId") ?? "agent";
    return { id, agentId, agentName: text(item, "agentName") ?? agentId, ...(text(item, "role") ? { role: text(item, "role") } : {}), ...(text(item, "model") ?? text(item, "modelId") ? { model: text(item, "model") ?? text(item, "modelId") } : {}), ...(text(item, "thinking") ? { thinking: text(item, "thinking") } : {}), ...(numeric(item, "contextPct") !== undefined ? { contextPct: numeric(item, "contextPct") } : {}), ...(numeric(item, "inputTokens") !== undefined ? { inputTokens: numeric(item, "inputTokens") } : {}), ...(numeric(item, "outputTokens") !== undefined ? { outputTokens: numeric(item, "outputTokens") } : {}), ...(numeric(item, "elapsedMs") !== undefined ? { elapsedMs: numeric(item, "elapsedMs") } : {}), status: text(item, "status") ?? "idle", color: COLORS[index % COLORS.length]!, children: nested };
  };
  const forest = roots.flatMap((id) => { const node = build(id, new Set()); return node ? [node] : []; });
  for (const id of source.keys()) { if (!placed.has(id)) { const node = build(id, new Set()); if (node) forest.push(node); } }
  return forest.length === 1 ? forest[0] : { id: "Workflow", agentId: `${forest.length} roots`, agentName: "Workflow", status: "idle", color: "var(--brand)", children: forest, synthetic: true };
}

function usePanZoom(svg: React.RefObject<SVGSVGElement | null>) {
  const [view, setView] = useState<ViewState>({ k: 1, x: 0, y: 0 }); const drag = useRef<{ x: number; y: number; vx: number; vy: number }>(); const [grabbing, setGrabbing] = useState(false);
  useEffect(() => {
    const element = svg.current; if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); const rect = element.getBoundingClientRect(); const mx = event.clientX - rect.left; const my = event.clientY - rect.top;
      setView((prior) => { const k = Math.max(.25, Math.min(2.5, prior.k * (event.deltaY < 0 ? 1.12 : 1 / 1.12))); return { k, x: mx - (mx - prior.x) * (k / prior.k), y: my - (my - prior.y) * (k / prior.k) }; });
    };
    element.addEventListener("wheel", wheel, { passive: false }); return () => element.removeEventListener("wheel", wheel);
  }, [svg]);
  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => { drag.current = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y }; if (typeof event.currentTarget.setPointerCapture === "function") event.currentTarget.setPointerCapture(event.pointerId); setGrabbing(true); };
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => { const start = drag.current; if (start) setView((prior) => ({ ...prior, x: start.vx + event.clientX - start.x, y: start.vy + event.clientY - start.y })); };
  const finish = (event: ReactPointerEvent<SVGSVGElement>) => { drag.current = undefined; if (typeof event.currentTarget.hasPointerCapture === "function" && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); setGrabbing(false); };
  return { view, setView, grabbing, handlers: { onPointerDown, onPointerMove, onPointerUp: finish, onPointerCancel: finish } };
}

export default function TopologyGraph({ items }: { items: readonly TopologyRecord[] }) {
  const root = useMemo(() => graphForest(items), [items]); const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set()); const svg = useRef<SVGSVGElement>(null); const rawId = useId(); const graphId = rawId.replaceAll(":", ""); const patternId = `topology-dots-${graphId}`; const { view, setView, grabbing, handlers } = usePanZoom(svg);
  const layout = useMemo(() => {
    if (!root) return undefined;
    const visible = hierarchy(root, (node) => collapsed.has(node.id) ? undefined : node.children);
    let nodeW = NODE_W_MIN; for (const node of visible.descendants()) nodeW = Math.min(NODE_W_MAX, Math.max(nodeW, nodeWidthFor(node.data)));
    const placed = tree<GraphNode>().nodeSize([nodeW + 44, NODE_H + 62])(visible); const nodes = placed.descendants(); const xs = nodes.map((node) => node.x); const minX = Math.min(...xs); const maxX = Math.max(...xs); const maxY = Math.max(...nodes.map((node) => node.y));
    return { nodes, links: placed.links(), nodeW, width: maxX - minX + nodeW + 80, height: maxY + NODE_H + 60, offsetX: -minX + nodeW / 2 + 24 };
  }, [collapsed, root]);
  const fit = useCallback(() => {
    if (!layout || !svg.current) return; const box = svg.current.getBoundingClientRect(); if (box.width < 10 || box.height < 10) return;
    const k = Math.max(.35, Math.min(1.1, (box.width - 48) / layout.width, (box.height - 48) / layout.height)); setView({ k, x: (box.width - layout.width * k) / 2, y: Math.max(18, (box.height - layout.height * k) / 2) });
  }, [layout, setView]);
  useEffect(() => { const frame = requestAnimationFrame(fit); return () => cancelAnimationFrame(frame); }, [fit]);
  useEffect(() => { if (!svg.current || !("ResizeObserver" in window)) return; const observer = new ResizeObserver(() => fit()); observer.observe(svg.current); return () => observer.disconnect(); }, [fit]);
  const keydown = (event: React.KeyboardEvent<SVGSVGElement>) => {
    if (event.target !== event.currentTarget) return; const pan = 36;
    if (event.key === "+" || event.key === "=") setView((prior) => ({ ...prior, k: Math.min(2.5, prior.k * 1.15) })); else if (event.key === "-") setView((prior) => ({ ...prior, k: Math.max(.25, prior.k / 1.15) })); else if (event.key === "0" || event.key === "Home") fit(); else if (event.key === "ArrowLeft") setView((prior) => ({ ...prior, x: prior.x + pan })); else if (event.key === "ArrowRight") setView((prior) => ({ ...prior, x: prior.x - pan })); else if (event.key === "ArrowUp") setView((prior) => ({ ...prior, y: prior.y + pan })); else if (event.key === "ArrowDown") setView((prior) => ({ ...prior, y: prior.y - pan })); else return; event.preventDefault();
  };
  return <section aria-label="Topology hierarchy" className="topology-graph"><div className="graph-wrap"><div className="graph-controls"><button type="button" aria-label="Zoom in" onClick={() => setView((prior) => ({ ...prior, k: Math.min(2.5, prior.k * 1.15) }))}>+</button><button type="button" aria-label="Zoom out" onClick={() => setView((prior) => ({ ...prior, k: Math.max(.25, prior.k / 1.15) }))}>−</button><button type="button" aria-label="Fit topology to view" onClick={fit}>⤢</button></div>{layout && <svg ref={svg} className="graph-svg" {...handlers} role="group" tabIndex={0} aria-label="Agent topology. Use arrow keys to pan, plus and minus to zoom, and Home to fit." onKeyDown={keydown} style={{ cursor: grabbing ? "grabbing" : "grab" }}><defs><pattern id={patternId} width="26" height="26" patternUnits="userSpaceOnUse" patternTransform={`translate(${view.x},${view.y}) scale(${view.k})`}><circle cx="1.5" cy="1.5" r="1.1" className="g-dotgrid" /></pattern></defs><rect width="100%" height="100%" fill={`url(#${patternId})`} /><g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>{layout.links.map((link) => <path key={`${link.source.data.id}:${link.target.data.id}`} className={`g-edge ${statusClass(link.target.data.status) === "running" ? "running" : ""}`} d={edgePath(link, layout.offsetX)} />)}{layout.nodes.map((node) => <GraphCard key={node.data.id} node={node} offsetX={layout.offsetX} width={layout.nodeW} idPrefix={graphId} collapsed={collapsed.has(node.data.id)} onToggle={() => setCollapsed((prior) => { const next = new Set(prior); if (next.has(node.data.id)) next.delete(node.data.id); else next.add(node.data.id); return next; })} />)}</g></svg>}</div></section>;
}

function ThinkingDial({ x, y, level, lead }: { x: number; y: number; level: number; lead: boolean }) {
  const count = THINK_ORDER.length - 1; const gap = lead ? 2 : 1.2; const boxWidth = lead ? 34 : 20; const barWidth = Math.max(1.6, (boxWidth - gap * (count - 1)) / count); const maximum = lead ? 9 : 7; const minimum = lead ? 3.5 : 2.5;
  return <g>{Array.from({ length: count }, (_, index) => { const height = minimum + (maximum - minimum) * (index / (count - 1)); return <rect key={index} x={x + index * (barWidth + gap)} y={y + maximum - height} width={barWidth} height={height} rx="1" className={level >= index + 1 ? "g-bar-on" : "g-bar-off"} />; })}</g>;
}

function GraphCard({ node, offsetX, width, idPrefix, collapsed, onToggle }: { node: HierarchyPointNode<GraphNode>; offsetX: number; width: number; idPrefix: string; collapsed: boolean; onToggle(): void }) {
  const data = node.data; const tone = statusClass(data.status); const hasChildren = data.children.length > 0; const tag = modelTag(data.model); const badgeWidth = tagWidth(tag); const safe = data.id.replace(/[^a-z0-9]/giu, "") || "node"; const gradient = `node-wash-${idPrefix}-${safe}-${node.depth}`;
  if (data.synthetic) return <g className="g-node group-header" transform={`translate(${node.x + offsetX - width / 2},${node.y})`} aria-hidden="true"><rect className="g-bg" rx="14" width={width} height={NODE_H} opacity=".55" /><text className="g-id" x={width / 2} y={NODE_H / 2 + 4} textAnchor="middle">{data.agentName}</text></g>;
  const lead = hasChildren || data.role === "lead" || data.role === "orchestrator"; const level = thinkingLevel(data.thinking); const contextKnown = data.contextPct !== undefined; const context = Math.max(0, Math.min(100, Math.round(data.contextPct ?? 0))); const contextInk = contextColor(context); const totalKnown = data.inputTokens !== undefined || data.outputTokens !== undefined; const total = (data.inputTokens ?? 0) + (data.outputTokens ?? 0); const throughput = data.elapsedMs && data.outputTokens ? data.outputTokens / (data.elapsedMs / 1000) : undefined;
  return <g className={`g-node ${tone} ${lead ? "lead" : "worker"}`} transform={`translate(${node.x + offsetX - width / 2},${node.y})`} role="group" aria-label={`${data.agentName}, ${tag} model, ${normalizeThinking(data.thinking)} effort, ${data.status}`}><title>{`${data.agentName}\nnode: ${data.id}\nagent: ${data.agentId}\nmodel: ${data.model ?? "inherit"}\neffort: ${normalizeThinking(data.thinking)}\nstatus: ${data.status}`}</title><defs><linearGradient id={gradient} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor={data.color} stopOpacity=".14" /><stop offset=".5" stopColor={data.color} stopOpacity=".05" /><stop offset="1" stopColor={data.color} stopOpacity="0" /></linearGradient></defs><rect className="g-bg" rx="14" width={width} height={NODE_H} /><rect rx="14" width={width} height={NODE_H} fill={`url(#${gradient})`} /><rect width="3" height={NODE_H} rx="2" fill={data.color} opacity=".9" />{tone === "running" && <circle className="g-dot-halo" cx="17" cy="19" r="4" />}<circle className={`g-dot ${tone}`} cx="17" cy="19" r="3.5" /><text className="g-id" x="27" y="23" style={{ fontSize: 12 }}>{clip(data.agentName, Math.max(6, Math.floor((width - 12 - badgeWidth - 33) / 6.6)))}</text><g transform={`translate(${width - 12 - badgeWidth},13)`}><rect className="g-badge-bg" width={badgeWidth} height="14" rx="7" /><text className="g-badge-tx" x={badgeWidth / 2} y="10" textAnchor="middle" style={{ fontSize: 8 }}>{tag}</text></g><text className="g-cap" x="12" y="45" style={{ fontSize: 7.5 }}>CTX</text><rect x="32" y="40" width={width - 76} height="4" rx="2" className="g-ctx-track" /><rect x="32" y="40" width={(width - 76) * (context / 100)} height="4" rx="2" fill={contextInk} /><text x={width - 12} y="45" textAnchor="end" className="g-val" style={{ fontSize: 8.5, fill: contextInk }}>{contextKnown ? `${context}%` : "—"}</text><text className="g-cap" x="12" y="63" style={{ fontSize: 7 }}>THINK</text><ThinkingDial x={12} y={66} level={level} lead={lead} /><text className="g-cap" x="12" y="84" style={{ fontSize: 6.5 }}>{normalizeThinking(data.thinking).toUpperCase()}</text><text className="g-cap" x={width / 2} y="63" textAnchor="middle" style={{ fontSize: 7 }}>TOK/S</text><text className="g-val" x={width / 2} y="78" textAnchor="middle" style={{ fontSize: 10.5 }}>{throughput ? Math.round(throughput) : "—"}</text><text className="g-cap" x={width - 12} y="63" textAnchor="end" style={{ fontSize: 7 }}>TOTAL</text><text className="g-val" x={width - 12} y="78" textAnchor="end" style={{ fontSize: 10.5 }}>{totalKnown ? formatNumber(total) : "—"}</text>{hasChildren && <g className="g-collapse" transform={`translate(${width / 2 - 8},${NODE_H - 8})`} role="button" tabIndex={0} aria-label={`${collapsed ? "Expand" : "Collapse"} ${data.agentName}`} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onToggle(); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onToggle(); } }}><rect className="g-collapse-hit" x="-4" y="-4" width="24" height="24" rx="8" /><circle r="8" cx="8" cy="8" /><text x="8" y="12" textAnchor="middle">{collapsed ? "+" : "−"}</text></g>}</g>;
}
