// ── YAML-lite parser ─────────────────────────────────────────────────────────

import type { JsonRecord, YamlLine } from "./types";

export function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if ((ch === '"' || ch === "'") && line[i - 1] !== "\\") quote = quote === ch ? null : quote || ch;
    if (ch === "#" && !quote) return line.slice(0, i);
  }
  return line;
}

export function parseScalar(raw: string): any {
  const value = raw.trim();
  if (value === "") return "";
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    return inner ? inner.split(",").map((part) => parseScalar(part)) : [];
  }
  return value;
}

export function parseKeyValue(text: string): [string, any, boolean] {
  const idx = text.indexOf(":");
  if (idx < 0) return [text.trim(), "", false];
  const rawKey = text.slice(0, idx).trim();
  const key = rawKey.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
  const rawValue = text.slice(idx + 1).trim();
  return [key, parseScalar(rawValue), rawValue === ""];
}

export function parseYamlLite(raw: string): any {
  const lines: YamlLine[] = raw
    .split("\n")
    .map(stripComment)
    .filter((line) => line.trim() && line.trim() !== "---")
    .map((line) => ({ indent: line.match(/^\s*/)?.[0].length || 0, text: line.trim() }));

  function parseBlock(index: number, indent: number): [any, number] {
    if (index >= lines.length) return [{}, index];
    return lines[index].text.startsWith("- ") ? parseArray(index, indent) : parseObject(index, indent);
  }

  function parseArray(index: number, indent: number): [any[], number] {
    const output: any[] = [];
    while (index < lines.length && lines[index].indent === indent && lines[index].text.startsWith("- ")) {
      const rest = lines[index].text.slice(2).trim();
      index++;

      if (!rest) {
        const [child, next] = parseBlock(index, indent + 2);
        output.push(child);
        index = next;
        continue;
      }

      if (rest.includes(":")) {
        const [key, value, nested] = parseKeyValue(rest);
        const item: JsonRecord = {};
        if (nested) {
          const [child, next] = parseBlock(index, indent + 2);
          item[key] = child;
          index = next;
        } else {
          item[key] = value;
        }

        while (index < lines.length && lines[index].indent > indent) {
          const line = lines[index];
          if (line.indent !== indent + 2 || line.text.startsWith("- ")) break;
          const [childKey, childValue, childNested] = parseKeyValue(line.text);
          index++;
          if (childNested) {
            const [child, next] = parseBlock(index, line.indent + 2);
            item[childKey] = child;
            index = next;
          } else {
            item[childKey] = childValue;
          }
        }
        output.push(item);
      } else {
        output.push(parseScalar(rest));
      }
    }
    return [output, index];
  }

  function parseObject(index: number, indent: number): [JsonRecord, number] {
    const output: JsonRecord = {};
    while (index < lines.length && lines[index].indent === indent && !lines[index].text.startsWith("- ")) {
      const [key, value, nested] = parseKeyValue(lines[index].text);
      index++;
      if (nested) {
        const [child, next] = parseBlock(index, indent + 2);
        output[key] = child;
        index = next;
      } else {
        output[key] = value;
      }
    }
    return [output, index];
  }

  return parseBlock(0, lines[0]?.indent || 0)[0];
}

export function parseFrontmatter(raw: string): { attrs: JsonRecord; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { attrs: {}, body: raw.trim() };
  return { attrs: parseYamlLite(match[1]) || {}, body: match[2].trim() };
}
