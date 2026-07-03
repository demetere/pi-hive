import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import type { DomainScope, HiveState, KnowledgeRef } from "./types";
import { readIfSmall } from "./utils";

export function buildSharedContext(state: HiveState, ctx: ExtensionContext): string {
  if (!state.config) return "";
  const blocks: string[] = [];
  for (const entry of state.config.sharedContext || []) {
    const text = String(entry);
    const fullPath = resolve(ctx.cwd, text);
    const content = readIfSmall(fullPath);
    if (content) {
      blocks.push(`## ${text}\n${content}`);
      continue;
    }
    const looksLikePath = /[\\/]|\.[A-Za-z0-9]+$/.test(text) && !/\s/.test(text);
    blocks.push(looksLikePath ? `## ${text}\n[not readable: ${text}]` : `## Inline shared context\n${text}`);
  }
  return blocks.join("\n\n---\n\n");
}

// Context = always-injected knowledge (mental model, AGENTS.md, architecture
// docs, always-on behaviors). Full content is inlined into the prompt.
export function renderKnowledgeRefs(ctx: ExtensionContext, title: string, refs: KnowledgeRef[] | undefined): string {
  if (!refs?.length) return `## ${title}\nNo configured ${title.toLowerCase()}.`;
  const blocks = refs.map((ref) => {
    const fullPath = resolve(ctx.cwd, ref.path);
    const content = readIfSmall(fullPath, 96_000);
    const body = content || `[not readable: ${ref.path}]`;
    const meta = [
      ref.useWhen ? `use when: ${ref.useWhen}` : undefined,
      ref.updatable ? "this is your durable mental model; it is curated automatically after your run" : undefined,
    ].filter(Boolean).join("; ");
    return `### ${ref.path}${meta ? `\n_${meta}_` : ""}\n${body}`;
  });
  return `## ${title}\n${blocks.join("\n\n")}`;
}

export function renderDomainScopes(scopes: DomainScope[] | undefined): string {
  if (!scopes?.length) return "## Domain boundaries\nNo domains are configured, so file tools (read/edit/write/bash on paths) are all blocked for you. Work through delegation or report what you would need access to.";
  const rows = scopes.map((scope) => {
    const flags = `read=${scope.read ? "yes" : "no"}, upsert=${scope.upsert ? "yes" : "no"}, delete=${scope.delete ? "yes" : "no"}`;
    const globs = [
      scope.include?.length ? `include: ${scope.include.join(", ")}` : undefined,
      scope.exclude?.length ? `exclude: ${scope.exclude.join(", ")}` : undefined,
    ].filter(Boolean).join("; ");
    return `- ${scope.path} — ${flags}${globs ? ` — ${globs}` : ""}${scope.description ? ` — ${scope.description}` : ""}`;
  });
  return `## Domain boundaries\n${rows.join("\n")}\n\nThese scopes are ENFORCED at the tool layer: read/edit/write/bash calls on paths outside your domains are blocked. Include/exclude globs, when present, narrow a scope to matching files under that path. Treat domains as hard limits — if a task needs access you do not have, say so in your answer instead of attempting it.`;
}
