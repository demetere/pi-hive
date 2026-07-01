import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { relative, resolve } from "node:path";
import type { AgentRuntime, DomainScope, HiveState } from "../core/types";
import { currentAgentName } from "./session";
import { globToRegExp, globSpecificity, toPosixPath } from "./glob";
import { classify } from "./file-class";
import { checkPlannerStages, checkTypePolicy, type PolicyAction } from "./policy";

function runtimeForCaller(state: HiveState, callerName: string): AgentRuntime | undefined {
  return state.runtimes.get(callerName.toLowerCase())
    || (callerName === "Orchestrator" ? state.runtimes.get(state.config?.orchestrator?.name?.toLowerCase() || "") : undefined);
}

export function canDelegateTo(state: HiveState, callerName: string, targetName: string): { ok: boolean; reason?: string } {
  const caller = runtimeForCaller(state, callerName);
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

function matchingGlobSpecificity(patterns: string[] | undefined, relativePath: string): number | undefined {
  if (!patterns?.length) return 0;
  let best: number | undefined;
  for (const pattern of patterns) {
    if (!globToRegExp(pattern).test(relativePath)) continue;
    best = Math.max(best ?? 0, globSpecificity(pattern));
  }
  return best;
}

function excludedBy(scope: DomainScope, relativePath: string): boolean {
  return Boolean(scope.exclude?.some((pattern) => globToRegExp(pattern).test(relativePath)));
}

function domainScopeMatch(ctx: ExtensionContext, scope: DomainScope, target: string): { matches: boolean; specificity: number } {
  const scopePath = resolve(ctx.cwd, scope.path);
  if (!pathWithin(scopePath, target)) return { matches: false, specificity: 0 };
  const relativePath = toPosixPath(relative(scopePath, target) || ".");
  if (excludedBy(scope, relativePath)) return { matches: false, specificity: 0 };
  const includeSpecificity = matchingGlobSpecificity(scope.include, relativePath);
  if (includeSpecificity === undefined) return { matches: false, specificity: 0 };
  return { matches: true, specificity: scopePath.length * 10_000 + includeSpecificity };
}

// Resolve a capability for a target path by MOST-SPECIFIC-WINS:
//
//   - Consider every scope whose resolved path covers the target.
//   - If a scope has include globs, the target must match at least one include;
//     exclude globs remove the target from that scope.
//   - The deepest path wins. At the same path, matching include globs beat a
//     catch-all rule, so an explicit read-only catch-all can coexist with a
//     narrower "upsert tests only" rule.
//   - On an exact specificity tie, DENY wins (fail safe).
//   - If no scope matches, the default is DENY.
export function domainAllows(ctx: ExtensionContext, runtime: AgentRuntime, rawPath: string, capability: "read" | "upsert" | "delete"): boolean {
  const target = resolveDomainPath(ctx, rawPath);
  let bestSpecificity = -1;
  let decision = false;
  for (const scope of runtime.config.domain || []) {
    const match = domainScopeMatch(ctx, scope, target);
    if (!match.matches) continue;
    const opinion = scope[capability];
    if (match.specificity > bestSpecificity) {
      bestSpecificity = match.specificity;
      decision = opinion;
    } else if (match.specificity === bestSpecificity && opinion === false) {
      decision = false; // tie-break: deny wins
    }
  }
  return decision;
}

function formatScope(scope: DomainScope): string {
  const patterns = [
    scope.include?.length ? ` include:${scope.include.join("|")}` : "",
    scope.exclude?.length ? ` exclude:${scope.exclude.join("|")}` : "",
  ].join("");
  return `${scope.path}${patterns}`;
}

export function formatDomainRules(runtime: AgentRuntime, capability: "read" | "upsert" | "delete"): string {
  const scopes = runtime.config.domain || [];
  const allowed = scopes.filter((scope) => scope[capability] === true).map(formatScope);
  const denied = scopes.filter((scope) => scope[capability] === false).map(formatScope);
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

// Publish / history-creation operations blocked at the tool layer unless the
// agent has a non-empty `commit:` config field. Deliberately BROAD: it covers
// the common aliases and release runners. Local working-tree ops (git
// merge/rebase/cherry-pick/add/status/diff) are intentionally NOT here — they
// stay allowed. Word-boundary aware so `git commit-graph` or a path containing
// "commit" does not false-positive.
//
// Returns true if ANY statement in the command (split on shell separators) is a
// commit-class operation.
export function isCommitCommand(command: string): boolean {
  // Split on shell command separators so `cd x && git commit` is inspected
  // statement-by-statement; each statement's head token is what we classify.
  const statements = command.split(/(?:&&|\|\||;|\||\n)/);
  for (const statement of statements) {
    const trimmed = statement.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    const head = tokens[0];
    const sub = tokens[1] || "";
    // Bare git aliases that publish/create history.
    if (/^(gc|gcm|gca|gp|gpf|gcam)$/.test(head)) return true;
    if (head === "git") {
      // `git commit` (incl. commit-graph guard), push, tag (create), am (apply).
      if (sub === "commit") return true;
      if (sub === "push") return true;
      if (sub === "tag") return true;
      if (sub === "am") return true;
    }
    if (head === "gh") {
      // gh pr merge, gh release create.
      if (sub === "pr" && /\bmerge\b/.test(trimmed)) return true;
      if (sub === "release" && /\bcreate\b/.test(trimmed)) return true;
    }
    // Package publishes.
    if (/^(npm|pnpm|yarn|bun)$/.test(head) && sub === "publish") return true;
    // Release runners.
    if ((head === "just" || head === "make") && /\brelease\b/.test(sub)) return true;
    if (head === "npm" && sub === "run" && /\brelease\b/.test(tokens[2] || "")) return true;
  }
  return false;
}

// Check the TYPE-POLICY layer for one path+action. Runs first (cheaper, clearer
// message) and independently of the domain-glob layer; both must pass. When the
// agent has no agent-type (e.g. tests, normal mode) type-policy is skipped and
// only the domain layer applies. Returns a block reason or undefined.
function enforceTypePolicyForPath(runtime: AgentRuntime, ctx: ExtensionContext, rawPath: string, action: PolicyAction): string | undefined {
  const agentType = runtime.config.agentType;
  if (!agentType) return undefined;
  const target = resolveDomainPath(ctx, rawPath);
  const rel = relative(ctx.cwd, target);
  const cls = classify(rel);
  const decision = checkTypePolicy(agentType, cls, action);
  if (!decision.ok) return `${runtime.config.name}: ${decision.reason} ("${rawPath}" is class=${cls}.)`;
  // Planner stage-scoping: a planner may only write its assigned gate artifacts.
  if (agentType === "planner" && (action === "upsert" || action === "delete")) {
    const stageDecision = checkPlannerStages(runtime.config.stages, rel);
    if (!stageDecision.ok) return `${runtime.config.name}: ${stageDecision.reason}`;
  }
  return undefined;
}

export function enforceDomainForTool(state: HiveState, event: any, ctx: ExtensionContext): { block: true; reason: string } | undefined {
  const runtime = state.runtimes.get(currentAgentName().toLowerCase());
  if (!runtime) return undefined;

  const toolName = String(event.toolName || "");
  const readTools = new Set(["read", "grep", "find", "ls"]);
  const upsertTools = new Set(["write", "edit"]);

  if (readTools.has(toolName)) {
    for (const path of extractToolPaths(toolName, event.input)) {
      const typeBlock = enforceTypePolicyForPath(runtime, ctx, path, "read");
      if (typeBlock) return { block: true, reason: typeBlock };
      if (!domainAllows(ctx, runtime, path, "read")) {
        return { block: true, reason: `${runtime.config.name} cannot read ${path}. Read domains: ${formatDomainRules(runtime, "read")}` };
      }
    }
  }

  if (upsertTools.has(toolName)) {
    for (const path of extractToolPaths(toolName, event.input)) {
      const typeBlock = enforceTypePolicyForPath(runtime, ctx, path, "upsert");
      if (typeBlock) return { block: true, reason: typeBlock };
      if (!domainAllows(ctx, runtime, path, "upsert")) {
        return { block: true, reason: `${runtime.config.name} cannot modify ${path}. Upsert domains: ${formatDomainRules(runtime, "upsert")}` };
      }
    }
  }

  if (toolName === "bash") {
    const command = String(event.input?.command || "");

    // Commit gate: publish/history-creation is blocked unless the agent carries
    // a non-empty `commit:` field (a static config fact — no DB read). Local
    // working-tree ops (merge/rebase/add/…) are not commit-class and pass.
    if (isCommitCommand(command) && !runtime.config.commit?.trim()) {
      return { block: true, reason: `${runtime.config.name} cannot run commit/publish operations (no commit: field configured). This command creates history or publishes. Only agents with a commit: guidance field may commit; local git merge/rebase/add remain allowed.` };
    }

    const kind = bashMutationKind(command);
    const capability = kind === "read" ? "read" : kind;
    const paths = extractBashPathTokens(command);
    // Non-mutating bash is a "command"; mutating bash maps to upsert/delete.
    const policyAction: PolicyAction = kind === "read" ? "command" : kind;

    if (kind !== "read" && paths.length === 0) {
      // A pathless mutating bash still gets the type check (reviewers/leads are
      // denied any mutation regardless of path) before the in-domain-paths rule.
      const typeBlock = runtime.config.agentType
        ? (() => { const d = checkTypePolicy(runtime.config.agentType!, null, policyAction); return d.ok ? undefined : `${runtime.config.name}: ${d.reason}`; })()
        : undefined;
      if (typeBlock) return { block: true, reason: typeBlock };
      return { block: true, reason: `${runtime.config.name} cannot run mutating bash without explicit in-domain paths. Use edit/write or include a path inside: ${formatDomainRules(runtime, capability)}` };
    }

    for (const path of paths) {
      const typeBlock = enforceTypePolicyForPath(runtime, ctx, path, policyAction);
      if (typeBlock) return { block: true, reason: typeBlock };
      if (!domainAllows(ctx, runtime, path, capability)) {
        return { block: true, reason: `${runtime.config.name} cannot ${capability} ${path} via bash. Allowed ${capability} domains: ${formatDomainRules(runtime, capability)}` };
      }
    }
  }

  return undefined;
}
