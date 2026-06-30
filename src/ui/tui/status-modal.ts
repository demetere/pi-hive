/**
 * /hive-status canvas modal.
 *
 * Renders the agent hierarchy as an n8n-style top-down node graph: boxed nodes
 * connected by vertical wires, on a virtual canvas you pan like a map (arrows /
 * hjkl). Running agents pulse and their incoming wire "flows". Closes on Esc/q.
 *
 * Rendering is ANSI-safe: the graph is first laid out as a grid of PLAIN cells
 * (char + a style tag), the viewport is clipped on that plain grid, and color is
 * applied per-cell only at the end — so panning never slices an escape sequence.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentConfig, AgentRuntime, HiveState } from "../../core/types";
import { configuredChildAgents, hexAnsi } from "../../core/utils";

// ── Cell grid ────────────────────────────────────────────────────────────────
// Each canvas cell is a single visible char plus a style hint the colorizer uses.
type CellStyle =
  | "none"        // plain / dim structure
  | "wire"        // static connector
  | "flow"        // animated bright wire segment
  | "box-idle"
  | "box-active"  // pulsing node border
  | "box-done"
  | "box-error"
  | "label"
  | "stat";

interface Cell {
  ch: string;
  style: CellStyle;
  hex?: string; // per-agent color (overrides the style's theme role when set)
}

interface Grid {
  cells: Cell[][]; // [row][col]
  width: number;
  height: number;
}

function makeGrid(width: number, height: number): Grid {
  const cells: Cell[][] = [];
  for (let r = 0; r < height; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < width; c++) row.push({ ch: " ", style: "none" });
    cells.push(row);
  }
  return { cells, width, height };
}

function put(grid: Grid, row: number, col: number, ch: string, style: CellStyle) {
  if (row < 0 || row >= grid.height || col < 0 || col >= grid.width) return;
  grid.cells[row][col] = { ch, style };
}

function putText(grid: Grid, row: number, col: number, text: string, style: CellStyle) {
  for (let i = 0; i < text.length; i++) put(grid, row, col + i, text[i], style);
}

// Stamp a per-agent color onto a rectangle of already-placed cells.
function stampHex(grid: Grid, r0: number, c0: number, r1: number, c1: number, hex?: string) {
  if (!hex) return;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (r < 0 || r >= grid.height || c < 0 || c >= grid.width) continue;
      grid.cells[r][c].hex = hex;
    }
  }
}

// Truncate (ANSI-aware) then pad with spaces to exactly `width` visible columns.
// Padding is what stops background content bleeding through the modal.
function fitToWidth(text: string, width: number): string {
  const truncated = truncateToWidth(text, width, "");
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

// ── Layout: place the tree top-down ──────────────────────────────────────────
// Each node becomes a fixed-size box. Siblings are spread horizontally; depth
// adds rows. Returns the laid-out grid plus the connector geometry to draw wires.

const BOX_W = 30;
const BOX_H = 5;       // top border, name, model·thinking, stat, bottom border
const GAP_X = 3;       // horizontal space between sibling subtrees
const GAP_Y = 2;       // vertical space (rows) between parent and child boxes

interface Placed {
  agent: AgentConfig;
  runtime?: AgentRuntime;
  row: number;   // top row of the box
  col: number;   // left col of the box
  centerCol: number;
  children: Placed[];
}

// First pass: compute the pixel width each subtree needs.
function subtreeWidth(agent: AgentConfig): number {
  const kids = configuredChildAgents(agent);
  if (!kids.length) return BOX_W;
  const childrenW = kids.map(subtreeWidth).reduce((a, b) => a + b, 0) + GAP_X * (kids.length - 1);
  return Math.max(BOX_W, childrenW);
}

// Second pass: assign positions within [leftCol, …].
function place(agent: AgentConfig, state: HiveState, row: number, leftCol: number): Placed {
  const totalW = subtreeWidth(agent);
  const runtime = state.runtimes.get(agent.name.toLowerCase());
  const kids = configuredChildAgents(agent);

  let placed: Placed;
  if (!kids.length) {
    const col = leftCol + Math.floor((totalW - BOX_W) / 2);
    placed = { agent, runtime, row, col, centerCol: col + Math.floor(BOX_W / 2), children: [] };
  } else {
    const childRow = row + BOX_H + GAP_Y;
    const children: Placed[] = [];
    let cursor = leftCol;
    for (const kid of kids) {
      const w = subtreeWidth(kid);
      children.push(place(kid, state, childRow, cursor));
      cursor += w + GAP_X;
    }
    // Center the parent over the span of its children.
    const first = children[0].centerCol;
    const last = children[children.length - 1].centerCol;
    const centerCol = Math.floor((first + last) / 2);
    const col = centerCol - Math.floor(BOX_W / 2);
    placed = { agent, runtime, row, col, centerCol, children };
  }
  return placed;
}

function statusBoxStyle(runtime?: AgentRuntime): CellStyle {
  switch (runtime?.status) {
    case "running": return "box-active";
    case "done": return "box-done";
    case "error": return "box-error";
    default: return "box-idle";
  }
}

// "google/gemini-3.5-flash" → "gemini-3.5-flash"; "openai-codex/gpt-5.5" → "gpt-5.5".
// "inherit"/empty → "inherit". The provider prefix is dropped to fit the box.
function shortModel(model?: string): string {
  if (!model || model === "inherit") return "inherit";
  const slash = model.lastIndexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

// The model · thinking line for a node, e.g. "gemini-3.5-flash · medium".
function nodeModelLine(agent: AgentConfig): string {
  const m = shortModel(agent.model);
  const t = agent.thinking || "off";
  return `${m} · ${t}`;
}

function nodeStat(runtime?: AgentRuntime): string {
  if (!runtime) return "idle";
  const tok = runtime.inputTokens + runtime.outputTokens;
  const tokS = tok >= 1000 ? `${Math.round(tok / 1000)}K` : `${tok}`;
  const cost = `$${runtime.costUsd.toFixed(2)}`;
  if (runtime.status === "running") {
    // Derive elapsed from startedAt so nested agents (surfaced by the log
    // watcher, which has no per-second timer) tick live, not just direct ones.
    const elapsed = runtime.startedAt ? Date.now() - runtime.startedAt : runtime.elapsedMs || 0;
    return `${tokS} ${cost} ${Math.max(0, Math.round(elapsed / 1000))}s`;
  }
  if (runtime.status === "idle" && tok === 0) return "idle";
  return `${tokS} ${cost} ${Math.round(runtime.contextPct)}%`;
}

// Draw a node's box + its stat line into the grid.
function drawBox(grid: Grid, p: Placed) {
  const style = statusBoxStyle(p.runtime);
  const { row, col } = p;
  const icon = p.runtime?.status === "running" ? "●"
    : p.runtime?.status === "done" ? "✓"
    : p.runtime?.status === "error" ? "✗" : "◆";
  const inner = BOX_W - 2;
  // borders
  put(grid, row, col, "╭", style);
  put(grid, row, col + BOX_W - 1, "╮", style);
  put(grid, row + BOX_H - 1, col, "╰", style);
  put(grid, row + BOX_H - 1, col + BOX_W - 1, "╯", style);
  for (let c = 1; c < BOX_W - 1; c++) {
    put(grid, row, col + c, "─", style);
    put(grid, row + BOX_H - 1, col + c, "─", style);
  }
  for (let r = 1; r < BOX_H - 1; r++) {
    put(grid, row + r, col, "│", style);
    put(grid, row + r, col + BOX_W - 1, "│", style);
  }
  // name line
  const name = `${icon} ${p.agent.name}`.slice(0, inner);
  putText(grid, row + 1, col + 1, name.padEnd(inner), "label");
  // model · thinking line
  const modelLine = nodeModelLine(p.agent).slice(0, inner);
  putText(grid, row + 2, col + 1, modelLine.padEnd(inner), "stat");
  // stat line (tokens · cost · elapsed)
  const stat = nodeStat(p.runtime).slice(0, inner);
  putText(grid, row + 3, col + 1, stat.padEnd(inner), "stat");
  // Tint the whole box (border + name + stat) with the agent's configured color.
  stampHex(grid, row, col, row + BOX_H - 1, col + BOX_W - 1, p.agent.color);
}

// Draw the vertical wire from a parent box down to a child box. `frame` drives
// the flowing bright segment when the child is running.
function drawWire(grid: Grid, parent: Placed, child: Placed, frame: number) {
  const startRow = parent.row + BOX_H;          // just below parent
  const endRow = child.row - 1;                 // just above child
  const flowing = child.runtime?.status === "running";

  // vertical drop from parent center
  const colP = parent.centerCol;
  const colC = child.centerCol;
  const midRow = startRow + Math.max(0, Math.floor((endRow - startRow) / 2));

  const wireCellStyle = (r: number, c: number): CellStyle => {
    if (!flowing) return "wire";
    // a 2-cell bright window travels down then across then down
    const path: Array<[number, number]> = [];
    for (let rr = startRow; rr <= midRow; rr++) path.push([rr, colP]);
    const lo = Math.min(colP, colC), hi = Math.max(colP, colC);
    for (let cc = lo; cc <= hi; cc++) path.push([midRow, cc]);
    for (let rr = midRow; rr <= endRow; rr++) path.push([rr, colC]);
    const idx = path.findIndex(([pr, pc]) => pr === r && pc === c);
    if (idx < 0) return "wire";
    const head = frame % path.length;
    const dist = (idx - head + path.length) % path.length;
    return dist < 2 ? "flow" : "wire";
  };

  // drop from parent
  for (let r = startRow; r < midRow; r++) put(grid, r, colP, "│", wireCellStyle(r, colP));
  // elbow + horizontal run at midRow
  if (colP !== colC) {
    put(grid, midRow, colP, colC > colP ? "╰" : "╯", wireCellStyle(midRow, colP));
    const lo = Math.min(colP, colC), hi = Math.max(colP, colC);
    for (let c = lo + 1; c < hi; c++) put(grid, midRow, c, "─", wireCellStyle(midRow, c));
    put(grid, midRow, colC, colC > colP ? "╮" : "╭", wireCellStyle(midRow, colC));
  } else {
    put(grid, midRow, colP, "│", wireCellStyle(midRow, colP));
  }
  // drop into child
  for (let r = midRow + 1; r <= endRow; r++) put(grid, r, colC, "│", wireCellStyle(r, colC));
  // arrowhead into the child box
  put(grid, endRow, colC, "▼", flowing ? "flow" : "wire");
}

function drawTree(grid: Grid, p: Placed, frame: number) {
  drawBox(grid, p);
  for (const child of p.children) {
    drawWire(grid, p, child, frame);
    drawTree(grid, child, frame);
  }
}

// ── Colorize a clipped viewport row ──────────────────────────────────────────
function colorize(theme: any, cell: Cell, frame: number): string {
  const ch = cell.ch;
  // Per-agent hex takes precedence over the generic theme role.
  if (cell.hex && ch.trim()) {
    if (cell.style === "box-active") {
      const bright = Math.floor(frame / 3) % 2 === 0;
      const tinted = hexAnsi(cell.hex, bright ? theme.bold(ch) : ch, !bright);
      if (tinted) return tinted;
    } else if (cell.style === "box-idle") {
      const tinted = hexAnsi(cell.hex, ch, true);  // dimmed when idle
      if (tinted) return tinted;
    } else {
      const tinted = hexAnsi(cell.hex, ch);
      if (tinted) return tinted;
    }
  }
  switch (cell.style) {
    case "wire": return theme.fg("dim", ch);
    case "flow": return theme.fg("accent", theme.bold(ch));
    case "box-idle": return theme.fg("dim", ch);
    case "box-done": return theme.fg("success", ch);
    case "box-error": return theme.fg("error", ch);
    case "box-active": {
      // pulse the border bright<->accent every ~3 frames
      const bright = Math.floor(frame / 3) % 2 === 0;
      return bright ? theme.fg("accent", theme.bold(ch)) : theme.fg("muted", ch);
    }
    case "label": return theme.fg("toolTitle", ch);
    case "stat": return theme.fg("muted", ch);
    default: return ch;
  }
}

// ── The component ────────────────────────────────────────────────────────────
export function openStatusModal(state: HiveState, ctx: ExtensionContext) {
  if (!state.config) {
    if (ctx.hasUI) ctx.ui.notify("hive is not loaded", "error");
    return;
  }
  if (ctx.mode !== "tui") {
    if (ctx.hasUI) ctx.ui.notify("Hive status canvas is only available in TUI mode.", "warning");
    return;
  }

  void ctx.ui.custom(
    (tui: any, theme: any, _keybindings: any, done: (r: void) => void) => {
      let frame = 0;
      let viewRow = 0;   // viewport top within the canvas
      let viewCol = 0;   // viewport left within the canvas
      const timer = setInterval(() => { frame++; tui.requestRender(); }, 90);
      if (typeof timer.unref === "function") timer.unref();

      const buildGrid = (): Grid => {
        const roots = state.config!.agents;
        // Lay out the orchestrator as the single top node, with the top-level
        // agents as its children.
        const orchRuntime = state.runtimes.get(state.config!.orchestrator.name.toLowerCase());
        const pseudoRoot: AgentConfig = { ...state.config!.orchestrator, members: roots };
        // total canvas width = orchestrator subtree width
        const canvasW = subtreeWidth(pseudoRoot) + 2;
        const placedRoot = place(pseudoRoot, state, 1, 1);
        placedRoot.runtime = orchRuntime;
        // canvas height = deepest box bottom + 2
        let maxRow = 0;
        const walk = (p: Placed) => { maxRow = Math.max(maxRow, p.row + BOX_H); p.children.forEach(walk); };
        walk(placedRoot);
        const grid = makeGrid(canvasW, maxRow + 1);
        drawTree(grid, placedRoot, frame);
        return grid;
      };

      const component = {
        invalidate() {},
        handleInput(data: string) {
          // Esc or q closes
          if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, Key.enter) || data === "\u001b") { clearInterval(timer); done(); return; }
          // pan: arrows + hjkl
          const grid = buildGrid();
          const vh = Math.max(4, (tui.height || 24) - 8);
          const vw = Math.max(20, (tui.width || 80) - 4);
          const maxRow = Math.max(0, grid.height - vh);
          const maxCol = Math.max(0, grid.width - vw);
          if (matchesKey(data, Key.up) || matchesKey(data, "k") || data === "\u001b[A") viewRow = Math.max(0, viewRow - 1);
          else if (matchesKey(data, Key.down) || matchesKey(data, "j") || data === "\u001b[B") viewRow = Math.min(maxRow, viewRow + 1);
          else if (matchesKey(data, Key.left) || matchesKey(data, "h") || data === "\u001b[D") viewCol = Math.max(0, viewCol - 2);
          else if (matchesKey(data, Key.right) || matchesKey(data, "l") || data === "\u001b[C") viewCol = Math.min(maxCol, viewCol + 2);
          else if (matchesKey(data, "g")) { viewRow = 0; viewCol = 0; }
          tui.requestRender();
        },
        render(width: number): string[] {
          const grid = buildGrid();
          // Full bordered panel: border(1) + pad(1) on each side => inner = width-4.
          const modalWidth = Math.max(40, width);
          const innerW = Math.max(20, modalWidth - 4);
          // Adaptive height: show the whole graph if it fits within ~88% of the
          // terminal rows (minus panel chrome ≈ 6); otherwise cap and pan.
          const termRows = tui.terminal?.rows ?? tui.rows ?? tui.height ?? 24;
          const maxVh = Math.max(4, Math.floor(termRows * 0.88) - 6);
          const vh = Math.min(grid.height, maxVh);
          const vw = Math.min(innerW, grid.width);
          const heightOverflow = grid.height > vh;
          const widthOverflow = grid.width > vw;
          // clamp viewport (terminal may have resized)
          const maxRow = Math.max(0, grid.height - vh);
          const maxCol = Math.max(0, grid.width - vw);
          if (viewRow > maxRow) viewRow = maxRow;
          if (viewCol > maxCol) viewCol = maxCol;

          const bd = (t: string) => theme.fg("accent", t);
          const row = (text: string) => `${bd("│")} ${fitToWidth(text, innerW)} ${bd("│")}`;

          const running = Array.from(state.runtimes.values()).filter((r) => r.status === "running").length;
          const totalCost = Array.from(state.runtimes.values()).reduce((s, r) => s + r.costUsd, 0);
          const sid = state.session?.sessionId?.slice(0, 12) || "—";

          const title = theme.fg("accent", theme.bold("Hive")) +
            theme.fg("dim", ` · ${sid} · `) +
            theme.fg("success", `$${totalCost.toFixed(3)}`) +
            theme.fg("dim", " · ") +
            theme.fg(running ? "accent" : "muted", `${running} running`);

          const lines: string[] = [];
          lines.push(bd(`╭${"─".repeat(modalWidth - 2)}╮`));
          lines.push(row(title));
          lines.push(row(theme.fg("dim", "─".repeat(innerW))));

          // clipped + colorized canvas rows, each framed and padded to innerW
          for (let r = 0; r < vh; r++) {
            const gr = viewRow + r;
            if (gr >= grid.height) { lines.push(row("")); continue; }
            let out = "";
            for (let c = 0; c < vw; c++) {
              const gc = viewCol + c;
              const cell = gc < grid.width ? grid.cells[gr][gc] : { ch: " ", style: "none" as CellStyle };
              out += colorize(theme, cell, frame);
            }
            // out has vw visible cols; row() pads the remainder up to innerW
            lines.push(row(out));
          }

          lines.push(row(theme.fg("dim", "─".repeat(innerW))));
          const arrows = `${heightOverflow ? "↑↓" : ""}${widthOverflow ? "←→" : ""}`;
          const pan = arrows ? `${arrows} pan · g reset · ` : "";
          lines.push(row(theme.fg("dim", `${pan}esc close`)));
          lines.push(bd(`╰${"─".repeat(modalWidth - 2)}╯`));
          return lines;
        },
        dispose() { clearInterval(timer); },
      };
      queueMicrotask(() => tui.requestRender());
      return component;
    },
    {
      overlay: true,
      // Fit-to-content width: shrink to the graph (+ border/pad) when it fits,
      // otherwise cap at 90% of the terminal and let the canvas pan horizontally.
      overlayOptions: () => {
        const cols = process.stdout.columns || 120;
        const graphCols = subtreeWidth({ ...state.config!.orchestrator, members: state.config!.agents }) + 2;
        const desired = graphCols + 4; // border(2) + pad(2)
        const cap = Math.floor(cols * 0.9);
        // Fit the graph exactly when it comfortably fits; otherwise take 90% and pan.
        const width: number | string = desired <= cap ? desired : "90%";
        return { anchor: "center", width: width as any, minWidth: 40, maxHeight: "92%", margin: 1 };
      },
      onHandle: (handle: any) => handle.focus(),
    },
  );
}
