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
export type AgentLogPart =
  | { type: "text" | "thinking"; text: string }
  | { type: "toolResult"; name?: string; result: string; resultError: boolean }
  | AgentLogToolCallPart;

export interface AgentLogToolCallPart {
  type: "toolCall";
  id?: string;
  name?: string;
  args: unknown;
  result: string | null;
  resultError: boolean;
}

export type AgentLogEntry =
  | { kind: "meta"; text: string; ts?: string | number }
  | { kind: "message"; role: string; parts: AgentLogPart[]; ts?: string | number; usage?: unknown };

export interface ParsedAgentLog extends Omit<JsonlPage, "text"> { entries: AgentLogEntry[]; }

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalTimestamp(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

export function parseAgentLog(
  file: string,
  options: number | { after?: number; before?: number; maxBytes?: number } = {},
): ParsedAgentLog {
  const pageOptions = typeof options === "number"
    ? (options > 0 ? { after: options } : { before: Number.MAX_SAFE_INTEGER })
    : options;
  const page = readJsonlPage(file, pageOptions);
  const entries: AgentLogEntry[] = [];
  // Maps a toolCallId -> its toolCall part, so a later toolResult message can be
  // merged onto the call it answers (within this parse pass).
  const toolCallIndex = new Map<string, AgentLogToolCallPart>();
  for (const line of page.text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    const record = objectRecord(parsed);
    if (!record) continue;
    const timestamp = optionalTimestamp(record.timestamp);
    if (record.type === "model_change") {
      const model = optionalString(record.modelId) || optionalString(record.model);
      const provider = optionalString(record.provider);
      if (model) entries.push({ kind: "meta", text: `model → ${provider ? `${provider}/` : ""}${model}`, ts: timestamp });
      continue;
    }
    if (record.type === "thinking_level_change") {
      const level = optionalString(record.thinkingLevel) || optionalString(record.level);
      if (level) entries.push({ kind: "meta", text: `thinking → ${level}`, ts: timestamp });
      continue;
    }
    if (record.type !== "message") continue;
    const message = objectRecord(record.message) || record;
    const role = optionalString(message.role) || "assistant";

    // A toolResult arrives as its own message (role:"toolResult") carrying the
    // toolCallId of the call it answers. Attach it to the matching toolCall
    // part so the UI can render call+result as one collapsible card.
    if (role === "toolResult") {
      const text = typeof message.content === "string" ? message.content
        : Array.isArray(message.content) ? message.content.map((item) => {
          if (typeof item === "string") return item;
          return optionalString(objectRecord(item)?.text) || "";
        }).join("\n")
        : "";
      const toolCallId = optionalString(message.toolCallId);
      const part = toolCallId ? toolCallIndex.get(toolCallId) : undefined;
      if (part) { part.result = text; part.resultError = message.isError === true; }
      else entries.push({
        kind: "message",
        role: "toolResult",
        parts: [{ type: "toolResult", name: optionalString(message.toolName), result: text, resultError: message.isError === true }],
        ts: timestamp,
      });
      continue;
    }

    const content: unknown[] = Array.isArray(message.content)
      ? message.content
      : [{ type: "text", text: String(message.content ?? "") }];
    const parts: AgentLogPart[] = [];
    for (const value of content) {
      const partRecord = objectRecord(value);
      if (!partRecord) continue;
      if (partRecord.type === "text" && typeof partRecord.text === "string" && partRecord.text) {
        parts.push({ type: "text", text: partRecord.text });
      } else if (partRecord.type === "thinking" && typeof partRecord.thinking === "string" && partRecord.thinking) {
        parts.push({ type: "thinking", text: partRecord.thinking });
      } else if (partRecord.type === "toolCall") {
        const id = optionalString(partRecord.id);
        const part: AgentLogToolCallPart = {
          type: "toolCall",
          id,
          name: optionalString(partRecord.name),
          args: partRecord.arguments ?? partRecord.input ?? {},
          result: null,
          resultError: false,
        };
        if (id) toolCallIndex.set(id, part);
        parts.push(part);
      }
    }
    if (parts.length) entries.push({ kind: "message", role, parts, ts: timestamp, usage: message.usage });
  }
  const { text: _text, ...meta } = page;
  return { entries, ...meta };
}
