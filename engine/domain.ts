import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import type { AgentRuntime, HiveState } from "../core/types";
import { currentAgentName } from "./session";

export function canDelegateTo(state: HiveState, callerName: string, targetName: string): { ok: boolean; reason?: string } {
  const caller = state.runtimes.get(callerName.toLowerCase());
  if (!caller) return { ok: true };
  // Delegation is scoped to direct reports for EVERY node, including the
  // orchestrator (whose reports are the team leads). No blanket bypass.
  const allowed = caller.config.allowedAgents;
  if (allowed && allowed.map((name) => name.toLowerCase()).includes(targetName.toLowerCase())) return { ok: true };
  if (allowed?.length === 0 || caller.config.role === "member") {
    return { ok: false, reason: `${caller.config.name} is not configured to delegate to other agents.` };
  }
  return { ok: false, reason: `${caller.config.name} can only delegate to: ${allowed?.join(", ") || "none"}.` };
}

export function pathWithin(parent: string, child: string): boolean {
  const normalizedParent = resolve(parent);
  const normalizedChild = resolve(child);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}

export function resolveDomainPath(ctx: ExtensionContext, rawPath: string): string {
  return resolve(ctx.cwd, rawPath || ".");
}

// Resolve a capability for a target path by MOST-SPECIFIC-WINS:
//
//   - Consider every scope whose resolved path is a prefix of (or equal to) the
//     target — i.e. every scope that "covers" the target.
//   - Among those, only scopes with an EXPLICIT opinion on this capability
//     (true or false) get a vote; scopes with `undefined` defer.
//   - The scope with the LONGEST path wins, so a deep `upsert: false` carves a
//     hole out of a broad `upsert: true`. On an exact-length tie between an
//     allow and a deny, DENY wins (fail safe).
//   - If no covering scope expresses an opinion, the default is DENY (false),
//     preserving the original "no domain ⇒ no access" contract.
//
// Capabilities are resolved independently, so `upsert: false` on a subtree
// denies writes there while reads still flow from a broader `read: true`.
export function domainAllows(ctx: ExtensionContext, runtime: AgentRuntime, rawPath: string, capability: "read" | "upsert" | "delete"): boolean {
  const target = resolveDomainPath(ctx, rawPath);
  let bestLen = -1;
  let decision = false;
  for (const scope of runtime.config.domain || []) {
    const opinion = scope[capability];
    if (opinion === undefined) continue; // no opinion → defer
    const scopePath = resolve(ctx.cwd, scope.path);
    if (!pathWithin(scopePath, target)) continue; // does not cover the target
    const len = scopePath.length;
    if (len > bestLen) {
      bestLen = len;
      decision = opinion;
    } else if (len === bestLen && opinion === false) {
      decision = false; // tie-break: deny wins
    }
  }
  return decision;
}

export function formatDomainRules(runtime: AgentRuntime, capability: "read" | "upsert" | "delete"): string {
  const scopes = runtime.config.domain || [];
  const allowed = scopes.filter((scope) => scope[capability] === true).map((scope) => scope.path);
  const denied = scopes.filter((scope) => scope[capability] === false).map((scope) => scope.path);
  if (allowed.length === 0 && denied.length === 0) return "none";
  const parts: string[] = [];
  if (allowed.length) parts.push(allowed.join(", "));
  if (denied.length) parts.push(`(denied: ${denied.join(", ")})`);
  return parts.join(" ");
}

export function extractToolPaths(toolName: string, input: any): string[] {
  const paths: string[] = [];
  const add = (value: any) => {
    if (typeof value === "string" && value.trim()) paths.push(value.trim());
    if (Array.isArray(value)) value.forEach(add);
  };

  add(input?.path);
  add(input?.paths);
  add(input?.file);
  add(input?.files);
  add(input?.filename);
  add(input?.directory);
  add(input?.cwd);

  if (["grep", "find", "ls"].includes(toolName) && paths.length === 0) paths.push(".");
  return Array.from(new Set(paths));
}

export function extractBashPathTokens(command: string): string[] {
  const matches = command.match(/(?:^|\s)(\.{0,2}\/?[A-Za-z0-9_.-]+\/[A-Za-z0-9_./@-]+|\/[A-Za-z0-9_./@-]+)/g) || [];
  return Array.from(new Set(matches
    .map((match) => match.trim())
    .filter((token) => !token.startsWith("http://") && !token.startsWith("https://"))));
}

export function bashMutationKind(command: string): "delete" | "upsert" | "read" {
  if (/\brm\b|\brmdir\b/.test(command)) return "delete";
  if (/\b(mv|cp|touch|mkdir|chmod|chown|ln|truncate)\b|>>?|\bsed\s+-i\b|\bperl\s+-pi\b|\btee\b/.test(command)) return "upsert";
  return "read";
}

export function enforceDomainForTool(state: HiveState, event: any, ctx: ExtensionContext): { block: true; reason: string } | undefined {
  const runtime = state.runtimes.get(currentAgentName().toLowerCase());
  if (!runtime) return undefined;

  const toolName = String(event.toolName || "");
  const readTools = new Set(["read", "grep", "find", "ls"]);
  const upsertTools = new Set(["write", "edit"]);

  if (readTools.has(toolName)) {
    for (const path of extractToolPaths(toolName, event.input)) {
      if (!domainAllows(ctx, runtime, path, "read")) {
        return { block: true, reason: `${runtime.config.name} cannot read ${path}. Read domains: ${formatDomainRules(runtime, "read")}` };
      }
    }
  }

  if (upsertTools.has(toolName)) {
    for (const path of extractToolPaths(toolName, event.input)) {
      if (!domainAllows(ctx, runtime, path, "upsert")) {
        return { block: true, reason: `${runtime.config.name} cannot modify ${path}. Upsert domains: ${formatDomainRules(runtime, "upsert")}` };
      }
    }
  }

  if (toolName === "bash") {
    const command = String(event.input?.command || "");
    const kind = bashMutationKind(command);
    const capability = kind === "read" ? "read" : kind;
    const paths = extractBashPathTokens(command);

    if (kind !== "read" && paths.length === 0) {
      return { block: true, reason: `${runtime.config.name} cannot run mutating bash without explicit in-domain paths. Use edit/write or include a path inside: ${formatDomainRules(runtime, capability)}` };
    }

    for (const path of paths) {
      if (!domainAllows(ctx, runtime, path, capability)) {
        return { block: true, reason: `${runtime.config.name} cannot ${capability} ${path} via bash. Allowed ${capability} domains: ${formatDomainRules(runtime, capability)}` };
      }
    }
  }

  return undefined;
}
