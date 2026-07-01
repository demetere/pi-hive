// Shared glob helpers used by both the domain boundary (domain.ts) and the
// file classifier (file-class.ts). Kept in its own module so file-class.ts can
// reuse the exact same matcher without importing domain.ts (which would create
// a circular import: domain.ts → policy.ts → file-class.ts → domain.ts).

export function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

// Translate a glob (`*`, `**`, `**/`, `?`) into an anchored RegExp. `**/`
// matches zero or more path segments; `**` matches anything; `*` matches within
// a single segment; `?` matches one non-separator character.
export function globToRegExp(glob: string): RegExp {
  const pattern = toPosixPath(glob.trim());
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    const next = pattern[i + 1];
    const afterNext = pattern[i + 2];
    if (ch === "*" && next === "*" && afterNext === "/") {
      out += "(?:.*/)?";
      i += 2;
    } else if (ch === "*" && next === "*") {
      out += ".*";
      i += 1;
    } else if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeRegex(ch);
    }
  }
  return new RegExp(`${out}$`);
}

// More literal characters = more specific. Wildcard-heavy catch-alls stay low.
export function globSpecificity(glob: string): number {
  return toPosixPath(glob).replace(/[?*]/g, "").length;
}
