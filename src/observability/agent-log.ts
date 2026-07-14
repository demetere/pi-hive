import * as fs from "node:fs";
import * as path from "node:path";
import { readJsonlPage, type JsonlPage } from "../core/fs";

// All run logs for an agent: the current session file (the latest run) plus any
// archived "<slug>.run-N.jsonl" files. Returned newest-first as
// [{ id, label, file }], id "current" for the live file and "run-N" for archives.
export function agentRuns(sessionFile: string): { id: string; label: string; file: string }[] {
  const dir = path.dirname(sessionFile);
  const base = path.basename(sessionFile, ".jsonl");
  const runs: { id: string; label: string; file: string; n: number }[] = [];
  let files: string[] = [];
  try { files = fs.readdirSync(dir); } catch { /* */ }
  const re = new RegExp(`^${base}\\.run-(\\d+)\\.jsonl$`);
  for (const f of files) {
    const m = f.match(re);
    if (m) runs.push({ id: "run-" + m[1], label: "Run " + m[1], file: path.join(dir, f), n: Number(m[1]) });
  }
  runs.sort((a, b) => a.n - b.n);
  // current run is the highest-numbered run (archives are the earlier ones)
  const currentN = runs.length ? runs[runs.length - 1].n + 1 : 1;
  const out = runs.map((r) => ({ id: r.id, label: r.label, file: r.file }));
  if (fs.existsSync(sessionFile)) out.push({ id: "current", label: "Run " + currentN + " (current)", file: sessionFile });
  return out.reverse(); // newest first
}

// Parse pi session JSONL into UI-friendly entries. Each pi "message" record has
// a role and a content array of {text|thinking|toolCall|toolResult}. We flatten
// into a sequence the viewer renders as bubbles + collapsible tool calls.
export interface ParsedAgentLog extends Omit<JsonlPage, "text"> { entries: any[]; }

export function parseAgentLog(
  file: string,
  options: number | { after?: number; before?: number; maxBytes?: number } = {},
): ParsedAgentLog {
  const pageOptions = typeof options === "number"
    ? (options > 0 ? { after: options } : { before: Number.MAX_SAFE_INTEGER })
    : options;
  const page = readJsonlPage(file, pageOptions);
  const entries: any[] = [];
  // Maps a toolCallId -> its toolCall part, so a later toolResult message can be
  // merged onto the call it answers (within this parse pass).
  const toolCallIndex = new Map<string, any>();
  for (const line of page.text.split("\n")) {
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === "model_change") {
      const model = o.modelId || o.model || "";
      if (model) entries.push({ kind: "meta", text: `model → ${o.provider ? o.provider + "/" : ""}${model}`, ts: o.timestamp });
      continue;
    }
    if (o.type === "thinking_level_change") {
      const level = o.thinkingLevel || o.level || "";
      if (level) entries.push({ kind: "meta", text: `thinking → ${level}`, ts: o.timestamp });
      continue;
    }
    if (o.type !== "message") continue;
    const m = o.message || o;
    const role = m.role || "assistant";

    // A toolResult arrives as its own message (role:"toolResult") carrying the
    // toolCallId of the call it answers. Attach it to the matching toolCall
    // part so the UI can render call+result as one collapsible card.
    if (role === "toolResult") {
      const text = typeof m.content === "string" ? m.content
        : Array.isArray(m.content) ? m.content.map((x: any) => x.text ?? (typeof x === "string" ? x : "")).join("\n")
        : "";
      const part = m.toolCallId && toolCallIndex.get(m.toolCallId);
      if (part) { part.result = text; part.resultError = !!m.isError; }
      else entries.push({ kind: "message", role: "toolResult", parts: [{ type: "toolResult", name: m.toolName, result: text, resultError: !!m.isError }], ts: o.timestamp });
      continue;
    }

    const content = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content ?? "") }];
    const parts: any[] = [];
    for (const c of content) {
      if (c.type === "text" && c.text) parts.push({ type: "text", text: c.text });
      else if (c.type === "thinking" && c.thinking) parts.push({ type: "thinking", text: c.thinking });
      else if (c.type === "toolCall") {
        const part: any = { type: "toolCall", id: c.id, name: c.name, args: c.arguments ?? c.input ?? {}, result: null, resultError: false };
        if (c.id) toolCallIndex.set(c.id, part);
        parts.push(part);
      }
    }
    if (parts.length) entries.push({ kind: "message", role, parts, ts: o.timestamp, usage: m.usage });
  }
  const { text: _text, ...meta } = page;
  return { entries, ...meta };
}
