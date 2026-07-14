(() => {
  "use strict";
  const expectedOrigin = new URL(location.href).origin;
  const capabilityKeys = { rid: "__hive_rid", cwd: "__hive_cwd", nonce: "__hive_nonce" };
  const els = Object.fromEntries(["artifact","status","document","selection","comment","add-comment","annotations","feedback","error","deny","approve"].map((id) => [id, document.getElementById(id)]));
  let context = new URL(location.href);
  let lines = [];
  let selected = new Set();
  let anchor = null;
  let annotations = [];
  let busy = false;

  function apiUrl(path) {
    const url = new URL(path, location.href);
    for (const [name, key] of Object.entries(capabilityKeys)) url.searchParams.set(key, context.searchParams.get(name) || "");
    return url;
  }

  function setStatus(message) { els.status.textContent = message; }
  function showError(message) { els.error.textContent = message; els.error.hidden = !message; }
  function setBusy(value) {
    busy = value;
    els.approve.disabled = value;
    els.deny.disabled = value;
    els.addComment.disabled = value || selected.size === 0 || !els.comment.value.trim();
  }

  function selectedIndexes() { return [...selected].sort((a, b) => a - b); }
  function selectedQuote() { return selectedIndexes().map((index) => lines[index]).join("\n").slice(0, 1000); }
  function updateSelection() {
    const indexes = selectedIndexes();
    els.selection.textContent = indexes.length ? `Lines ${indexes.map((index) => index + 1).join(", ")}\n${selectedQuote()}` : "No lines selected";
    setBusy(busy);
  }

  function selectLine(index, extend) {
    if (extend && anchor != null) {
      selected.clear();
      const start = Math.min(anchor, index);
      const end = Math.max(anchor, index);
      for (let i = start; i <= end; i++) selected.add(i);
    } else if (selected.has(index)) {
      selected.delete(index);
      anchor = selected.size ? index : null;
    } else {
      selected.add(index);
      anchor = index;
    }
    for (const element of els.document.children) {
      const active = selected.has(Number(element.dataset.index));
      element.classList.toggle("selected", active);
      element.setAttribute("aria-selected", String(active));
    }
    updateSelection();
  }

  function renderDocument(markdown) {
    lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
    selected = new Set();
    anchor = null;
    els.document.replaceChildren(...lines.map((text, index) => {
      const row = document.createElement("div");
      row.className = "source-line";
      row.dataset.index = String(index);
      row.tabIndex = 0;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", "false");
      const content = document.createElement("span");
      content.className = "source-text";
      content.textContent = text || " ";
      row.append(content);
      row.addEventListener("click", (event) => selectLine(index, event.shiftKey));
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectLine(index, event.shiftKey); }
      });
      return row;
    }));
    updateSelection();
  }

  function renderAnnotations() {
    if (!annotations.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "No anchored comments.";
      els.annotations.replaceChildren(empty);
      return;
    }
    els.annotations.replaceChildren(...annotations.map((annotation, index) => {
      const card = document.createElement("div");
      card.className = "annotation";
      const quote = document.createElement("div");
      quote.className = "annotation-quote";
      quote.textContent = annotation.quote;
      const comment = document.createElement("div");
      comment.className = "annotation-comment";
      comment.textContent = annotation.comment;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.title = "Remove comment";
      remove.setAttribute("aria-label", "Remove anchored comment");
      remove.textContent = "×";
      remove.addEventListener("click", () => { annotations.splice(index, 1); renderAnnotations(); });
      card.append(quote, comment, remove);
      return card;
    }));
  }

  async function load(nextContext) {
    context = nextContext;
    annotations = [];
    els.feedback.value = "";
    els.comment.value = "";
    renderAnnotations();
    showError("");
    setBusy(true);
    setStatus("Loading artifact…");
    els.artifact.textContent = context.searchParams.get("rid") || "";
    try {
      const response = await fetch(apiUrl("/api/plan"), { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Unable to load artifact (${response.status})`);
      renderDocument(body.plan || "");
      setStatus("Ready");
    } catch (error) {
      renderDocument("");
      showError(error instanceof Error ? error.message : String(error));
      setStatus("Unavailable");
    } finally { setBusy(false); }
  }

  async function decide(approved) {
    if (busy) return;
    showError("");
    setBusy(true);
    setStatus(approved ? "Approving…" : "Sending feedback…");
    try {
      const response = await fetch(apiUrl(approved ? "/api/approve" : "/api/deny"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: els.feedback.value, annotations }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Review failed (${response.status})`);
      setStatus(approved ? "Approved" : "Changes requested");
      parent.postMessage({ type: "pi-hive-review-result", rid: context.searchParams.get("rid"), approved }, expectedOrigin);
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
      setStatus("Review failed");
      setBusy(false);
    }
  }

  els.comment.addEventListener("input", () => setBusy(busy));
  els.addComment.addEventListener("click", () => {
    const comment = els.comment.value.trim();
    const quote = selectedQuote();
    if (!comment || !quote || annotations.length >= 100) return;
    annotations.push({ type: "comment", quote, comment });
    selected.clear();
    els.comment.value = "";
    renderAnnotations();
    updateSelection();
    for (const element of els.document.children) { element.classList.remove("selected"); element.setAttribute("aria-selected", "false"); }
  });
  els.approve.addEventListener("click", () => void decide(true));
  els.deny.addEventListener("click", () => void decide(false));
  window.addEventListener("message", (event) => {
    if (event.source !== parent || event.origin !== expectedOrigin || event.data?.type !== "pi-hive-review-context") return;
    let next;
    try { next = new URL(String(event.data.url)); } catch { return; }
    if (next.origin !== expectedOrigin || next.pathname !== "/pl-review/" || !next.searchParams.get("rid") || !next.searchParams.get("cwd") || !next.searchParams.get("nonce")) return;
    void load(next);
  });
  parent.postMessage({ type: "pi-hive-review-ready" }, expectedOrigin);
  void load(context);
})();
