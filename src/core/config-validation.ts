import { lstatSync, statSync } from "node:fs";
import * as path from "node:path";
import { hasForeignAbsoluteSyntax, resolveCanonicalPath, resolveProjectPath } from "./safe-path";
import { slug } from "./format";

export const CONFIG_LIMITS = {
  configBytes: 512 * 1024,
  agents: 128,
  treeDepth: 8,
  contextRefs: 256,
  injectedContextBytes: 2 * 1024 * 1024,
  subagentOutputLimit: 1_000_000,
  maxParallel: 64,
  conversationLines: 10_000,
} as const;

function object(value: unknown, label: string): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
}

function keys(value: Record<string, any>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label}.${key} is not a recognized configuration key.`);
  }
}

function string(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
}

function optionalBoolean(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "boolean") throw new Error(`${label} must be true or false when provided.`);
}

function positiveInteger(value: unknown, label: string, max: number): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new Error(`${label} must be a positive integer between 1 and ${max}.`);
  }
}

function stringList(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${label} must be a list of strings.`);
  value.forEach((entry, index) => string(entry, `${label}[${index}]`));
}

function configuredPath(cwd: string, value: string, label: string, allowOutside: boolean, options: { mustExistMarkdown?: boolean; allowMissing?: boolean } = {}): string | undefined {
  if (hasForeignAbsoluteSyntax(value)) throw new Error(`${label} uses absolute path syntax for another platform: ${value}`);
  if (!allowOutside && path.isAbsolute(value)) throw new Error(`${label} must be project-relative; absolute paths require allow-outside-project: true.`);
  const lexical = path.isAbsolute(value) ? value : path.resolve(cwd, value);
  const relative = path.relative(cwd, lexical);
  if (!allowOutside && (relative === ".." || relative.startsWith(`..${path.sep}`))) {
    throw new Error(`${label} must stay inside the project; outside paths require allow-outside-project: true.`);
  }
  const resolved = allowOutside
    ? resolveCanonicalPath(lexical, { allowMissing: options.allowMissing })
    : resolveProjectPath(cwd, value, { allowMissing: options.allowMissing });
  if (!resolved) throw new Error(`${label} is missing, unreadable, or escapes its allowed root: ${value}`);
  if (options.mustExistMarkdown) {
    if (!/\.md$/i.test(value)) throw new Error(`${label} must reference a Markdown (.md) file.`);
    let stat;
    try { stat = lstatSync(resolved.canonicalPath); } catch { throw new Error(`${label} must exist: ${value}`); }
    if (!stat.isFile()) throw new Error(`${label} must be a regular Markdown file: ${value}`);
  }
  return resolved.exists ? resolved.canonicalPath : undefined;
}

const REF_KEYS = ["path", "useWhen", "updatable", "allowOutsideProject"] as const;
const DOMAIN_KEYS = ["path", "read", "upsert", "delete", "include", "exclude", "description", "allowOutsideProject"] as const;
const AGENT_KEYS = [
  "name", "slug", "path", "color", "model", "tools", "thinking", "consultWhen",
  "routingTags", "responsibilities", "context", "skills", "domain", "members", "children",
  "allowedAgents", "agentType", "stages", "network", "commit", "allowOutsideProject",
] as const;

interface ValidationTotals {
  agents: number;
  refs: number;
  injectedBytes: number;
  seen: Map<string, string>;
}

function addFileBytes(file: string | undefined, totals: ValidationTotals): void {
  if (!file) return;
  try { totals.injectedBytes += statSync(file).size; } catch { /* optional refs may not exist */ }
}

function refs(cwd: string, value: unknown, label: string, totals: ValidationTotals): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${label} must be a list.`);
  for (let index = 0; index < value.length; index++) {
    const entry = value[index];
    object(entry, `${label}[${index}]`);
    keys(entry, REF_KEYS, `${label}[${index}]`);
    string(entry.path, `${label}[${index}].path`);
    if (entry.useWhen !== undefined) string(entry.useWhen, `${label}[${index}].useWhen`);
    optionalBoolean(entry.updatable, `${label}[${index}].updatable`);
    optionalBoolean(entry.allowOutsideProject, `${label}[${index}].allowOutsideProject`);
    const resolved = configuredPath(cwd, entry.path, `${label}[${index}].path`, entry.allowOutsideProject === true, { allowMissing: true });
    addFileBytes(resolved, totals);
    totals.refs++;
    if (totals.refs > CONFIG_LIMITS.contextRefs) throw new Error(`Configured context/skill refs exceed the limit of ${CONFIG_LIMITS.contextRefs}.`);
  }
}

function domains(cwd: string, value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${label} must be a list.`);
  value.forEach((entry, index) => {
    object(entry, `${label}[${index}]`);
    keys(entry, DOMAIN_KEYS, `${label}[${index}]`);
    string(entry.path, `${label}[${index}].path`);
    optionalBoolean(entry.allowOutsideProject, `${label}[${index}].allowOutsideProject`);
    configuredPath(cwd, entry.path, `${label}[${index}].path`, entry.allowOutsideProject === true, { allowMissing: true });
  });
}

function agent(cwd: string, value: unknown, label: string, depth: number, totals: ValidationTotals): void {
  object(value, label);
  keys(value, AGENT_KEYS, label);
  if (depth > CONFIG_LIMITS.treeDepth) throw new Error(`${label} exceeds the maximum agent tree depth of ${CONFIG_LIMITS.treeDepth}.`);
  totals.agents++;
  if (totals.agents > CONFIG_LIMITS.agents) throw new Error(`Configured agents exceed the limit of ${CONFIG_LIMITS.agents}.`);
  string(value.name, `${label}.name`);
  string(value.path, `${label}.path`);
  optionalBoolean(value.allowOutsideProject, `${label}.allowOutsideProject`);
  const prompt = configuredPath(cwd, value.path, `${label}.path`, value.allowOutsideProject === true, { mustExistMarkdown: true });
  addFileBytes(prompt, totals);
  const key = slug(String(value.slug || value.name));
  const prior = totals.seen.get(key);
  if (prior) throw new Error(`Duplicate agent slug "${key}" at ${label}; already used at ${prior}.`);
  totals.seen.set(key, label);
  stringList(value.routingTags, `${label}.routingTags`);
  stringList(value.responsibilities, `${label}.responsibilities`);
  refs(cwd, value.context, `${label}.context`, totals);
  refs(cwd, value.skills, `${label}.skills`, totals);
  domains(cwd, value.domain, `${label}.domain`);
  for (const childKey of ["members", "children"] as const) {
    const children = value[childKey];
    if (children === undefined) continue;
    if (!Array.isArray(children)) throw new Error(`${label}.${childKey} must be a list.`);
    children.forEach((child, index) => agent(cwd, child, `${label}.${childKey}[${index}]`, depth + 1, totals));
  }
}

function team(cwd: string, value: unknown, label: string, totals: ValidationTotals): void {
  object(value, label);
  keys(value, ["main", "orchestrator", "agents"], label);
  if (value.main && value.orchestrator) throw new Error(`${label} must not define both main and orchestrator.`);
  const main = value.main || value.orchestrator;
  if (!main) throw new Error(`${label}.main is required.`);
  agent(cwd, main, `${label}.main`, 1, totals);
  if (value.agents !== undefined && !Array.isArray(value.agents)) throw new Error(`${label}.agents must be a list.`);
  (value.agents || []).forEach((entry: unknown, index: number) => agent(cwd, entry, `${label}.agents[${index}]`, 1, totals));
}

export function validateConfigSize(raw: string): void {
  if (Buffer.byteLength(raw) > CONFIG_LIMITS.configBytes) throw new Error(`hive-config.yaml exceeds the ${CONFIG_LIMITS.configBytes}-byte size limit.`);
}

export function validateRawConfig(cwd: string, raw: string, parsed: unknown): void {
  validateConfigSize(raw);
  object(parsed, "hive-config.yaml");
  keys(parsed, ["settings", "sharedContext", "shared_context", "planning", "hive", "orchestrator", "agents"], "hive-config.yaml");
  if (parsed.sharedContext !== undefined && parsed.shared_context !== undefined) throw new Error("Define only one of shared-context or shared_context.");

  const settings = parsed.settings;
  if (settings !== undefined) {
    object(settings, "settings");
    keys(settings, ["subagentOutputLimit", "defaultTools", "maxParallel", "secretPaths", "distiller"], "settings");
    positiveInteger(settings.subagentOutputLimit, "settings.subagentOutputLimit", CONFIG_LIMITS.subagentOutputLimit);
    positiveInteger(settings.maxParallel, "settings.maxParallel", CONFIG_LIMITS.maxParallel);
    if (settings.defaultTools !== undefined) string(settings.defaultTools, "settings.defaultTools");
    stringList(settings.secretPaths, "settings.secretPaths");
    if (settings.distiller !== undefined) {
      object(settings.distiller, "settings.distiller");
      keys(settings.distiller, ["enabled", "model", "conversationLines"], "settings.distiller");
      optionalBoolean(settings.distiller.enabled, "settings.distiller.enabled");
      if (settings.distiller.model !== undefined) string(settings.distiller.model, "settings.distiller.model");
      positiveInteger(settings.distiller.conversationLines, "settings.distiller.conversationLines", CONFIG_LIMITS.conversationLines);
    }
  }

  const totals: ValidationTotals = { agents: 0, refs: 0, injectedBytes: 0, seen: new Map() };
  if (parsed.planning !== undefined) team(cwd, parsed.planning, "planning", totals);
  if (parsed.hive !== undefined) team(cwd, parsed.hive, "hive", totals);

  const shared = parsed.shared_context ?? parsed.sharedContext;
  if (shared !== undefined) {
    if (!Array.isArray(shared)) throw new Error("shared_context must be a list of strings.");
    shared.forEach((entry: unknown, index: number) => {
      if (typeof entry !== "string") throw new Error(`shared_context[${index}] must be a string; got ${Array.isArray(entry) ? "array" : typeof entry}.`);
      if (!entry.trim()) throw new Error(`shared_context[${index}] must be a non-empty string.`);
      const looksLikePath = /[\\/]|\.[A-Za-z0-9]+$/.test(entry) && !/\s/.test(entry);
      if (looksLikePath) addFileBytes(configuredPath(cwd, entry, `shared_context[${index}]`, false, { allowMissing: true }), totals);
      else totals.injectedBytes += Buffer.byteLength(entry);
    });
  }
  if (totals.injectedBytes > CONFIG_LIMITS.injectedContextBytes) {
    throw new Error(`Configured prompt/context content is ${totals.injectedBytes} bytes; limit is ${CONFIG_LIMITS.injectedContextBytes} bytes.`);
  }
}
