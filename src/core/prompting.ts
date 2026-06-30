import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import type { DomainScope, HiveState, KnowledgeRef } from "./types";
import { readIfSmall } from "./utils";

export function buildSharedContext(state: HiveState, ctx: ExtensionContext): string {
  if (!state.config) return "";
  const blocks: string[] = [];
  for (const relative of state.config.sharedContext || []) {
    const fullPath = resolve(ctx.cwd, relative);
    const content = readIfSmall(fullPath);
    if (content) blocks.push(`## ${relative}\n${content}`);
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

// Skills = on-demand procedures. Only a menu (name + use-when) is injected; the
// agent pulls full content with the load_skill tool when a skill applies.
export function skillName(ref: KnowledgeRef): string {
  const normalized = ref.path.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  const file = parts[parts.length - 1] || "skill";
  const stem = file.replace(/\.[^.]+$/, "");
  // Agent Skills convention stores every skill body in SKILL.md. Using the file
  // stem would make every configured skill appear as "SKILL", causing models to
  // pass the descriptive use-when text as a pseudo-query. Use the parent folder
  // as the callable key for */SKILL.md instead.
  if (stem.toLowerCase() === "skill" && parts.length >= 2) return parts[parts.length - 2];
  return stem;
}

export function renderSkillMenu(refs: KnowledgeRef[] | undefined): string {
  if (!refs?.length) return "## Skills\nNo skills configured.";
  const rows = refs.map((ref) => {
    const key = skillName(ref);
    return `- ${key}: call load_skill with name \"${key}\" — ${ref.useWhen || "use when relevant to the task"}`;
  });
  return `## Skills (call load_skill with the exact skill key to read the full instructions)\nLoad a skill before doing work it applies to. Read any "always" skills first. Do not pass a natural-language query; pass exactly one listed skill key.\n${rows.join("\n")}`;
}

export function renderDomainScopes(scopes: DomainScope[] | undefined): string {
  if (!scopes?.length) return "## Domain boundaries\nNo domains are configured, so file tools (read/edit/write/bash on paths) are all blocked for you. Work through delegation or report what you would need access to.";
  const rows = scopes.map((scope) => {
    const flags = [
      scope.read ? "read" : undefined,
      scope.upsert ? "upsert" : undefined,
      scope.delete ? "delete" : undefined,
    ].filter(Boolean).join("/") || "no access";
    return `- ${scope.path} — ${flags}${scope.description ? ` — ${scope.description}` : ""}`;
  });
  return `## Domain boundaries\n${rows.join("\n")}\n\nThese scopes are ENFORCED at the tool layer: read/edit/write/bash calls on paths outside your domains are blocked. Treat them as hard limits — if a task needs access you do not have, say so in your answer instead of attempting it.`;
}
