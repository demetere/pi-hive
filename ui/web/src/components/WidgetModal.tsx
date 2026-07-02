import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

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

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const head = (inModal: boolean) => (
    <div className="w-head">
      <span className="w-title">{props.title}</span>
      {props.sub}
      <span className="w-tools">
        {props.headExtra}
        {props.expandable !== false && (
          <button title={inModal ? "Close" : "Expand"} onClick={() => setOpen(!inModal)}>{inModal ? "✕" : "⤢"}</button>
        )}
      </span>
    </div>
  );

  return (
    <>
      <section className={`widget ${props.className || ""}`}>
        {head(false)}
        {open
          ? <div className="w-collapsed" onClick={() => setOpen(true)}>Expanded — click to focus, Esc to close</div>
          : props.children}
      </section>
      {open && createPortal(
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            {head(true)}
            <div className="modal-body">{props.children}</div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
