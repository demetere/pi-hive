import { useEffect, useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../hooks/useFocusTrap";

// A widget shell that can expand into a full-screen modal. To avoid mounting
// the (stateful) body twice, the children render in exactly one place at a
// time: inline normally, or inside the modal when expanded. The inline slot
// shows a lightweight placeholder while expanded.
export default function Widget(props: {
  title: string;
  sub?: ReactNode;
  headExtra?: ReactNode;
  className?: string;
  expandable?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const trapRef = useFocusTrap<HTMLDivElement>(open);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const head = (inModal: boolean) => (
    <div className="w-head">
      <span id={inModal ? titleId : undefined} className="w-title">{props.title}</span>
      {props.sub}
      <span className="w-tools">
        {props.headExtra}
        {props.expandable !== false && (
          <button type="button" aria-label={inModal ? `Close ${props.title}` : `Expand ${props.title}`} title={inModal ? "Close" : "Expand"} onClick={() => setOpen(!inModal)}>{inModal ? "✕" : "⤢"}</button>
        )}
      </span>
    </div>
  );

  return (
    <>
      <section className={`widget ${props.className || ""}`}>
        {head(false)}
        {open
          ? <button type="button" className="w-collapsed" onClick={() => trapRef.current?.focus()}>Expanded — activate to focus, Esc to close</button>
          : props.children}
      </section>
      {open && createPortal(
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div ref={trapRef} className="modal-panel" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
            {head(true)}
            <div className="modal-body">{props.children}</div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
