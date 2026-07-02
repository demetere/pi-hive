import { createPortal } from "react-dom";
import { useHive } from "../store";
import { dismissToast } from "../store/raw";

// Toast stack (K1/Decision 7). A single mount renders every transient
// notification pushed by a mutating flow (comment/approve, override save, prune,
// session/project delete). Bottom-right, click-to-dismiss, auto-expiring.
export default function Toast() {
  const toasts = useHive((s) => s.toasts);
  if (!toasts.length) return null;
  return createPortal(
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => {
        const accent = t.kind === "error" ? "var(--crit)" : t.kind === "success" ? "var(--done)" : "var(--brand)";
        return (
          <div
            key={t.id}
            role="status"
            className="pointer-events-auto flex items-start gap-2 max-w-[360px] rounded-lg border border-line bg-panel px-3 py-2 text-[12px] text-ink shadow-lg cursor-pointer"
            style={{ borderLeftWidth: 3, borderLeftColor: accent }}
            onClick={() => dismissToast(t.id)}
            title="Dismiss"
          >
            <span className="mt-[1px] leading-none" style={{ color: accent }}>
              {t.kind === "error" ? "✕" : t.kind === "success" ? "✓" : "ℹ"}
            </span>
            <span className="min-w-0 break-words">{t.message}</span>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
