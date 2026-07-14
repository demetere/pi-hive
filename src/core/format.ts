export function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
}

// Convert "#rrggbb" to a truecolor ANSI-wrapped string. Returns null on bad
// input so callers can fall back to a theme role. `dim` halves the brightness.
export function hexAnsi(hex: string | undefined, text: string, dim = false): string | null {
  if (!hex) return null;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  let r = parseInt(m[1].slice(0, 2), 16);
  let g = parseInt(m[1].slice(2, 4), 16);
  let b = parseInt(m[1].slice(4, 6), 16);
  if (dim) { r = Math.round(r * 0.5); g = Math.round(g * 0.5); b = Math.round(b * 0.5); }
  return `\u001b[38;2;${r};${g};${b}m${text}\u001b[39m`;
}

export function textFromMessage(message: any): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part: any) => part?.text || part?.content || "")
      .filter(Boolean)
      .join("\n");
  }
  if (typeof message.text === "string") return message.text;
  try {
    return JSON.stringify(message.content ?? message);
  } catch {
    return String(message);
  }
}

// Best-effort JSON stringify for bounded telemetry previews (tool args). Never
// throws; falls back to String() on circular/unserializable values.
export function safeJson(value: any): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// Extract a text preview from a tool-execution result (string, content array,
// or arbitrary object). Bounded by the caller via truncateMiddle.
export function textOfResult(result: any): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result.text === "string") return result.text;
  if (Array.isArray(result.content)) {
    return result.content.map((part: any) => part?.text || part?.content || "").filter(Boolean).join("\n");
  }
  if (typeof result.output === "string") return result.output;
  return safeJson(result);
}

function safeLimit(value: number, fallback: number, ceiling = 1_000_000): number {
  return Number.isFinite(value) && value > 0 ? Math.min(ceiling, Math.floor(value)) : fallback;
}

export function truncateMiddle(text: string, max: number): string {
  const limit = safeLimit(max, 12_000);
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.65);
  const tail = Math.max(0, limit - head - 32);
  return `${text.slice(0, head)}\n\n... [truncated] ...\n\n${text.slice(text.length - tail)}`;
}

// Bounded, truncated view of an AssistantMessage's diagnostics for telemetry
// (Item 9). Caps the count, truncates each message, and OMITS absent fields
// (R4.3) — an entry never carries `message: undefined`, and an entry with neither
// type nor message is dropped. Returns undefined when there is nothing to record.
export function boundedDiagnostics(
  diagnostics: unknown,
  max = 20,
): Array<{ type?: string; message?: string }> | undefined {
  if (!Array.isArray(diagnostics) || !diagnostics.length) return undefined;
  const out: Array<{ type?: string; message?: string }> = [];
  const limit = safeLimit(max, 20, 100);
  for (const d of diagnostics) {
    if (out.length >= limit) break;
    const type = (d as any)?.type ? String((d as any).type) : undefined;
    const message = (d as any)?.error?.message ? truncateMiddle(String((d as any).error.message), 300) : undefined;
    if (!type && !message) continue;
    const entry: { type?: string; message?: string } = {};
    if (type) entry.type = type;
    if (message) entry.message = message;
    out.push(entry);
  }
  return out.length ? out : undefined;
}

// Clip to a head slice and report whether clipping happened, so callers can
// stamp a machine-readable `truncated` flag on the telemetry payload (J6) rather
// than having downstream code re-infer truncation from a length threshold.
export function clip(text: string, max: number): { text: string; truncated: boolean } {
  const limit = safeLimit(max, 8_000);
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

export function tailLines(text: string, limit: number): string {
  const lines = text.split("\n").filter(Boolean);
  const count = safeLimit(limit, 80, 10_000);
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

export function extractFinalAnswer(text: string): string | null {
  const match = text.match(/<final_answer>([\s\S]*?)<\/final_answer>/i);
  return match?.[1]?.trim() || null;
}
