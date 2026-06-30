// Parse a cwd into a human project label. Keeps the parent segment when the
// last one is generic (backend/frontend/...) or repeats the parent (iMed/iMed).
export function projectName(cwd?: string): string {
  if (!cwd) return "unknown";
  const parts = String(cwd).split("/").filter(Boolean);
  if (!parts.length) return cwd;
  const last = parts[parts.length - 1];
  const parent = parts[parts.length - 2];
  const generic = new Set(["backend", "frontend", "web", "app", "src", "api", "server", "packages"]);
  if (parts.length >= 2 && (generic.has(last) || last === parent)) {
    return parent + " / " + last;
  }
  return last;
}
