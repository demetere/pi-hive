import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";

export interface View { k: number; x: number; y: number; }

// SVG pan/zoom. `view` is state (drives the transform); the in-flight pan drag
// is a ref so mid-drag moves don't re-render. Pan is armed on pointerdown but
// only begins (and captures the pointer) once movement passes a small threshold,
// so a down+up with no movement stays a click and reaches a node's onClick.
export function usePanZoom(svgRef: RefObject<SVGSVGElement | null>) {
  const [view, setView] = useState<View>({ k: 1, x: 0, y: 0 });
  const pan = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const panMoved = useRef(false);
  const [grabbing, setGrabbing] = useState(false);

  // Wheel-to-cursor zoom. Attached manually as non-passive so preventDefault
  // works (React attaches onWheel passively in some setups).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setView((v) => {
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        const k = Math.max(0.25, Math.min(2.5, v.k * factor));
        const rect = svg.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        return { k, x: mx - (mx - v.x) * (k / v.k), y: my - (my - v.y) * (k / v.k) };
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [svgRef]);

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    setView((v) => { pan.current = { x: e.clientX, y: e.clientY, vx: v.x, vy: v.y }; return v; });
    panMoved.current = false;
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent) => {
    const p = pan.current;
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (!panMoved.current && Math.hypot(dx, dy) < 4) return; // still a potential click
    if (!panMoved.current) {
      panMoved.current = true;
      setGrabbing(true);
      try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* */ }
    }
    setView((v) => ({ ...v, x: p.vx + dx, y: p.vy + dy }));
  }, []);

  const onPointerUp = useCallback(() => { pan.current = null; panMoved.current = false; setGrabbing(false); }, []);

  return { view, setView, grabbing, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerLeave: onPointerUp } };
}
