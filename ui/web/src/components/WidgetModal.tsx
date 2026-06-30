import { createSignal, onCleanup, onMount, type JSX, Show } from "solid-js";
import { Portal } from "solid-js/web";
import "./modal.css";

// A widget shell that can expand into a full-screen modal. To avoid mounting
// the (stateful) body twice, the children render in exactly one place at a
// time: inline normally, or inside the modal when expanded. The inline slot
// shows a lightweight placeholder while expanded.
export default function Widget(props: {
  title: string;
  sub?: JSX.Element;
  headExtra?: JSX.Element;
  class?: string;
  expandable?: boolean;
  children: JSX.Element;
}) {
  const [open, setOpen] = createSignal(false);

  function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));

  const head = (inModal: boolean) => (
    <div class="w-head">
      <span class="w-title">{props.title}</span>
      {props.sub}
      <span class="w-tools">
        {props.headExtra}
        <Show when={props.expandable !== false}>
          <button title={inModal ? "Close" : "Expand"} onClick={() => setOpen(!inModal)}>{inModal ? "✕" : "⤢"}</button>
        </Show>
      </span>
    </div>
  );

  return (
    <>
      <section class={`widget ${props.class || ""}`}>
        {head(false)}
        <Show when={!open()} fallback={<div class="w-collapsed" onClick={() => setOpen(true)}>Expanded — click to focus, Esc to close</div>}>
          {props.children}
        </Show>
      </section>
      <Show when={open()}>
        <Portal>
          <div class="modal-backdrop" onClick={() => setOpen(false)}>
            <div class="modal-panel" onClick={(e) => e.stopPropagation()}>
              {head(true)}
              <div class="modal-body">{props.children}</div>
            </div>
          </div>
        </Portal>
      </Show>
    </>
  );
}
