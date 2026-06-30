import { createSignal, onCleanup, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import "./modal.css";

interface ConfirmState {
  title: string;
  message: JSX.Element;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => unknown | Promise<unknown>;
}

// Global confirm-dialog singleton. Call `confirm({...})` from anywhere to pop a
// modal; it resolves the action on confirm. Keeps destructive actions behind a
// real dialog instead of inline buttons.
const [state, setState] = createSignal<ConfirmState | null>(null);
const [busy, setBusy] = createSignal(false);

export function confirmAction(opts: ConfirmState) { setBusy(false); setState(opts); }

export default function ConfirmModal() {
  function close() { if (!busy()) setState(null); }
  async function go() {
    const s = state(); if (!s) return;
    setBusy(true);
    try { await s.onConfirm(); } finally { setBusy(false); setState(null); }
  }
  function onKey(e: KeyboardEvent) {
    if (!state()) return;
    if (e.key === "Escape") close();
    if (e.key === "Enter") go();
  }
  document.addEventListener("keydown", onKey);
  onCleanup(() => document.removeEventListener("keydown", onKey));

  return (
    <Show when={state()}>
      {(s) => (
        <Portal>
          <div class="modal-backdrop confirm-backdrop" onClick={close}>
            <div class="confirm-card" onClick={(e) => e.stopPropagation()}>
              <div class={`confirm-icon ${s().danger ? "danger" : ""}`}>{s().danger ? "🗑" : "?"}</div>
              <h3 class="confirm-title">{s().title}</h3>
              <div class="confirm-msg">{s().message}</div>
              <div class="confirm-actions">
                <button class="btn pill" disabled={busy()} onClick={close}>Cancel</button>
                <button class={`btn ${s().danger ? "danger" : "primary"}`} disabled={busy()} onClick={go}>
                  {busy() ? "Deleting…" : (s().confirmLabel || "Confirm")}
                </button>
              </div>
            </div>
          </div>
        </Portal>
      )}
    </Show>
  );
}
