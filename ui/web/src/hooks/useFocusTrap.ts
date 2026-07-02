import { useEffect, useRef } from "react";

const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Focus management for a modal/portal panel. When `active` becomes true, moves
// focus into the panel and keeps Tab cycling within it; on deactivation, returns
// focus to whatever was focused before the modal opened. Attach the returned ref
// to the panel element.
export function useFocusTrap<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T | null>(null);
  const lastFocused = useRef<Element | null>(null);

  useEffect(() => {
    if (!active) return;
    const panel = ref.current;
    if (!panel) return;
    lastFocused.current = document.activeElement;

    const focusFirst = () => {
      const nodes = panel.querySelectorAll<HTMLElement>(FOCUSABLE);
      (nodes[0] || panel).focus();
    };
    focusFirst();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null || n === document.activeElement);
      if (!nodes.length) { e.preventDefault(); return; }
      const first = nodes[0], last = nodes[nodes.length - 1];
      const activeEl = document.activeElement;
      if (e.shiftKey && (activeEl === first || !panel.contains(activeEl))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && activeEl === last) { e.preventDefault(); first.focus(); }
    };
    panel.addEventListener("keydown", onKeyDown);

    return () => {
      panel.removeEventListener("keydown", onKeyDown);
      const prev = lastFocused.current;
      if (prev instanceof HTMLElement) prev.focus();
    };
  }, [active]);

  return ref;
}
