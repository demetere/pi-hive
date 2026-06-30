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

export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.65);
  const tail = Math.max(0, max - head - 32);
  return `${text.slice(0, head)}\n\n... [truncated] ...\n\n${text.slice(text.length - tail)}`;
}

export function tailLines(text: string, limit: number): string {
  const lines = text.split("\n").filter(Boolean);
  return lines.slice(Math.max(0, lines.length - limit)).join("\n");
}

export function extractFinalAnswer(text: string): string | null {
  const match = text.match(/<final_answer>([\s\S]*?)<\/final_answer>/i);
  return match?.[1]?.trim() || null;
}
