import { globToRegExp, toPosixPath } from "./glob";

// The language-agnostic classes the type-policy layer reasons about. The
// test-vs-production split is deliberately NOT modeled here (it differs per
// language and the fallback `code` is the dangerous class to misclassify) — it
// is expressed per-agent with domain include/exclude globs instead.
export type FileClass = "spec" | "docs" | "tasks" | "code";

// Ordered, most-specific-first. The first class whose any-glob matches wins;
// anything unmatched falls back to "code". `tasks` is checked before `spec`
// and `docs` so a plan's tasks.md classifies as `tasks` (writable by coders),
// not `spec`; `spec` before `docs` so plan/openspec markdown is `spec`, not
// generic `docs`.
const RULES: Array<{ cls: FileClass; globs: string[] }> = [
  { cls: "tasks", globs: ["**/tasks.md", "**/todo.md", ".pi/hive/tasks/**"] },
  { cls: "spec",  globs: [".pi/hive/plans/**", ".pi/hive/specs/**", "openspec/**"] },
  { cls: "docs",  globs: ["**/*.md", "docs/**", "**/*.mdx"] },
];

const COMPILED = RULES.map((rule) => ({ cls: rule.cls, regexes: rule.globs.map(globToRegExp) }));

// Classify a cwd-relative path. The enforcer resolves absolute paths, so pass
// `relative(ctx.cwd, target)`.
export function classify(pathRelativeToCwd: string): FileClass {
  const rel = toPosixPath(pathRelativeToCwd || ".");
  for (const rule of COMPILED) {
    if (rule.regexes.some((regex) => regex.test(rel))) return rule.cls;
  }
  return "code";
}
