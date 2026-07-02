import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useHive } from "../store";
import { clearConfirm } from "../store/raw";
import { useFocusTrap } from "../hooks/useFocusTrap";

// Global confirm-dialog singleton. Call `confirmAction({...})` (from store/raw)
// anywhere to pop a modal; it resolves the action on confirm.
export default function ConfirmModal() {
  const state = useHive((s) => s.confirm);
  const [busy, setBusy] = useState(false);
  const trapRef = useFocusTrap<HTMLDivElement>(!!state);

  function close() { if (!busy) clearConfirm(); }
  async function go() {
    if (!state) return;
    setBusy(true);
    try { await state.onConfirm(); } finally { setBusy(false); clearConfirm(); }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!state) return;
      if (e.key === "Escape") { if (!busy) clearConfirm(); }
      if (e.key === "Enter") go();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, busy]);

  // reset busy whenever a fresh confirm opens
  useEffect(() => { setBusy(false); }, [state]);

  if (!state) return null;
  return createPortal(
    <div className="modal-backdrop confirm-backdrop" onClick={close}>
      <div ref={trapRef} className="confirm-card" role="alertdialog" aria-modal="true" aria-label={state.title} onClick={(e) => e.stopPropagation()}>
        <div className={`confirm-icon ${state.danger ? "danger" : ""}`}>{state.danger ? "🗑" : "?"}</div>
        <h3 className="confirm-title">{state.title}</h3>
        <div className="confirm-msg">{state.message}</div>
        <div className="confirm-actions">
          <button className="btn pill" disabled={busy} onClick={close}>Cancel</button>
          <button className={`btn ${state.danger ? "danger" : "primary"}`} disabled={busy} onClick={go}>
            {busy ? "Deleting…" : (state.confirmLabel || "Confirm")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
