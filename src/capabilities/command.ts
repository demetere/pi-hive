import type { CompiledFilesystemPolicy, FilesystemAuthorizationDecision } from "./filesystem";
import { authorizeFilesystemOperation } from "./filesystem";
import { authorizeNetworkTargets } from "./network";
import type { FilesystemOperation, NormalizedCapabilities, ShellCapability } from "./types";

export const COMMAND_POLICY_VERSION = "pi-hive-command-policy-v1";
const MAX_COMMAND_BYTES = 32_768;
const MAX_TOKENS = 256;
const MAX_EFFECTS = 64;

export interface CommandEffect { readonly operation: FilesystemOperation; readonly path: string }
export interface CommandAttemptMetadata {
  readonly version: typeof COMMAND_POLICY_VERSION;
  readonly command: string;
  readonly executable?: string;
  readonly classes: readonly ShellCapability[];
  readonly effects: readonly CommandEffect[];
  readonly networkTargets: readonly string[];
  readonly git: boolean;
  readonly mutating: boolean;
  readonly idempotency: "idempotent" | "non-idempotent" | "unknown";
  readonly processTreeOwned: true;
  readonly acceptedRisks: readonly ("bare-filename-read" | "interpreter-hidden-write")[];
  readonly valid: boolean;
  readonly reason?: string;
}
export interface CommandAuthorization {
  readonly ok: boolean;
  readonly reason: string;
  readonly metadata: CommandAttemptMetadata;
  readonly filesystem: readonly FilesystemAuthorizationDecision[];
}

function tokenize(command: string): { tokens: string[]; compound: boolean } | undefined {
  if (typeof command !== "string" || !command.trim() || Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES || command.includes("\0")) return undefined;
  const tokens: string[] = []; let current = ""; let quote = ""; let escaped = false; let compound = false;
  const push = () => { if (current) { tokens.push(current); current = ""; } };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) { current += character; escaped = false; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (character === quote) quote = ""; else current += character; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (/\s/u.test(character)) { push(); continue; }
    if (";|&<>`".includes(character) || (character === "$" && command[index + 1] === "(")) compound = true;
    current += character;
  }
  if (quote || escaped) return undefined;
  push();
  if (tokens.length === 0 || tokens.length > MAX_TOKENS) return undefined;
  return { tokens, compound };
}
const CLASS_ORDER: readonly ShellCapability[] = ["inspect", "test", "build", "package", "mutate", "execute-code"];
function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] { return Object.freeze([...new Set(values)].sort()); }
function orderedClasses(values: readonly ShellCapability[]): readonly ShellCapability[] { const set = new Set(values); return Object.freeze(CLASS_ORDER.filter((value) => set.has(value))); }
function effect(operation: FilesystemOperation, path: string): CommandEffect { return Object.freeze({ operation, path }); }
function hasPathShape(value: string): boolean { return value === "." || value.includes("/") || value.startsWith("."); }
function remoteGit(tokens: readonly string[]): boolean {
  const sub = tokens.find((token, index) => index > 0 && !token.startsWith("-"));
  return ["clone", "fetch", "pull", "push", "ls-remote"].includes(sub ?? "") || tokens.some((token) => /^(?:https?|ssh|git):\/\//u.test(token) || token.includes("@") && token.includes(":"));
}
function gitSubcommand(tokens: readonly string[]): string {
  return tokens.find((token, index) => index > 0 && !token.startsWith("-") && tokens[index - 1] !== "-c") ?? "";
}
function networkTargets(tokens: readonly string[], executable: string, gitRemote: boolean): string[] {
  const results: string[] = [];
  if (["curl", "wget", "ssh", "scp", "gh"].includes(executable)) for (const token of tokens.slice(1)) if (!token.startsWith("-") && (token.includes("://") || token.includes("@") || token.includes("."))) results.push(token);
  if (gitRemote) {
    for (const token of tokens.slice(1)) if (/^(?:https?|ssh|git):\/\//u.test(token) || token.includes("@") && token.includes(":")) results.push(token);
    if (results.length === 0) results.push("https://git-remote.invalid");
  }
  if (["npm", "pnpm", "yarn", "bun", "pip", "pip3"].includes(executable) && ["install", "add", "publish"].includes(tokens[1] ?? "")) results.push("https://registry.npmjs.org");
  return [...new Set(results)].slice(0, 32);
}

export function analyzeCommand(command: string): CommandAttemptMetadata {
  const parsed = tokenize(command);
  const invalid = (reason: string): CommandAttemptMetadata => Object.freeze({ version: COMMAND_POLICY_VERSION, command: String(command).slice(0, MAX_COMMAND_BYTES), classes: Object.freeze([]), effects: Object.freeze([]), networkTargets: Object.freeze([]), git: false, mutating: false, idempotency: "unknown", processTreeOwned: true, acceptedRisks: Object.freeze([]), valid: false, reason });
  if (!parsed) return invalid("command is malformed or exceeds policy bounds");
  const { tokens, compound } = parsed; const executable = tokens[0];
  const classes: ShellCapability[] = []; const effects: CommandEffect[] = []; const risks: Array<"bare-filename-read" | "interpreter-hidden-write"> = [];
  let git = false; let mutating = false; let known = false; let opaque = false; let gitRemote = false; let forbiddenAlias = false; let ambiguousEffects = false;

  if (["pwd", "ls", "cat", "head", "tail", "grep", "rg", "find", "stat", "wc", "which", "type", "echo", "printf"].includes(executable)) { classes.push("inspect"); known = true; }
  if (["node", "python", "python3", "ruby", "perl", "sh", "bash", "zsh", "deno", "tsx"].includes(executable) || executable.startsWith("./")) { classes.push("execute-code"); known = true; opaque = true; }
  if (["pytest", "jest", "vitest"].includes(executable) || ["npm", "pnpm", "yarn", "bun", "cargo", "go", "just"].includes(executable) && /^(?:run-)?test|^test/u.test(tokens[1] ?? "")) { classes.push("test", "execute-code"); known = true; opaque = true; }
  if (["tsc", "make", "cmake"].includes(executable) || ["npm", "pnpm", "yarn", "bun", "cargo", "go", "just"].includes(executable) && /build|compile/u.test(tokens.slice(1, 3).join(" "))) { classes.push("build", "execute-code"); known = true; opaque = true; }
  if (["npm", "pnpm", "yarn", "bun", "pip", "pip3"].includes(executable) && ["install", "add", "publish"].includes(tokens[1] ?? "")) { classes.push("package", "execute-code"); known = true; opaque = true; mutating = true; }
  if (["npm", "pnpm", "yarn", "bun", "just"].includes(executable) && (tokens[1] === "run" || executable === "just") && !classes.includes("test") && !classes.includes("build")) { classes.push("execute-code"); known = true; opaque = true; }
  if (executable === "rm") { classes.push("mutate"); known = true; mutating = true; for (const token of tokens.slice(1)) if (!token.startsWith("-")) effects.push(effect("delete", token)); }
  if (executable === "find" && tokens.includes("-delete")) { classes.push("mutate"); mutating = true; const path = tokens[1]; if (path && !path.startsWith("-")) effects.push(effect("delete", path)); }
  if (["mkdir", "touch"].includes(executable)) { classes.push("mutate"); known = true; mutating = true; for (const token of tokens.slice(1)) if (!token.startsWith("-")) effects.push(effect("create", token)); }
  if (["mv", "cp"].includes(executable)) { classes.push("mutate"); known = true; mutating = true; const args = tokens.slice(1).filter((token) => !token.startsWith("-")); if (executable === "mv" && args[0]) effects.push(effect("delete", args[0])); if (args.at(-1)) effects.push(effect("create", args.at(-1)!)); }
  if (executable === "git") {
    known = true; git = true; const sub = gitSubcommand(tokens); gitRemote = remoteGit(tokens);
    const readonly = new Set(["status", "diff", "log", "show", "branch", "tag", "rev-parse", "ls-files"]);
    if (readonly.has(sub) && !tokens.includes("--delete") && !tokens.includes("-d") && !tokens.includes("-D")) classes.push("inspect");
    else { classes.push("mutate"); mutating = true; }
    forbiddenAlias = tokens.some((token) => token.startsWith("alias."));
    if (mutating || tokens.includes("-c") || tokens.some((token) => token.startsWith("core.hooksPath")) || ["submodule", "hook"].includes(sub)) { classes.push("execute-code"); opaque = true; }
    if (["checkout", "switch", "reset", "restore", "merge", "rebase", "pull", "submodule"].includes(sub)) { effects.push(effect("update", ".")); ambiguousEffects = true; }
  }
  if (["curl", "wget", "ssh", "scp", "gh"].includes(executable)) { classes.push("inspect"); known = true; }
  if (opaque) risks.push("interpreter-hidden-write");
  if (["cat", "head", "tail", "less", "more"].includes(executable) && tokens.slice(1).some((token) => !hasPathShape(token))) risks.push("bare-filename-read");
  const targets = networkTargets(tokens, executable, gitRemote);
  const pathlessMutation = mutating && effects.length === 0 && !(git && !["checkout", "switch", "reset", "restore", "merge", "rebase", "pull", "submodule"].includes(gitSubcommand(tokens)));
  const valid = known && !compound && !forbiddenAlias && !ambiguousEffects && !pathlessMutation && effects.length <= MAX_EFFECTS;
  return Object.freeze({ version: COMMAND_POLICY_VERSION, command, executable, classes: orderedClasses(classes), effects: Object.freeze(effects), networkTargets: Object.freeze(targets), git, mutating, idempotency: mutating ? "non-idempotent" : "idempotent", processTreeOwned: true, acceptedRisks: uniqueSorted(risks), valid, ...(valid ? {} : { reason: compound || forbiddenAlias ? "compound/ambiguous shell syntax" : ambiguousEffects ? "mutation effect set cannot be proven before execution" : pathlessMutation ? "pathless mutation" : "unknown or excessive command effects" }) });
}

export function authorizeCommand(command: string, capabilities: NormalizedCapabilities, filesystemPolicy?: CompiledFilesystemPolicy): CommandAuthorization {
  const metadata = analyzeCommand(command); const filesystem: FilesystemAuthorizationDecision[] = [];
  const deny = (reason: string): CommandAuthorization => Object.freeze({ ok: false, reason, metadata, filesystem: Object.freeze(filesystem) });
  if (!metadata.valid) return deny(metadata.reason ?? "command classification failed closed");
  for (const required of metadata.classes) if (!capabilities.shell.includes(required)) return deny(`shell capability ${required} is not granted`);
  if (metadata.git && !capabilities.git) return deny("Git capability is not granted");
  if (metadata.networkTargets.length) { const decision = authorizeNetworkTargets(metadata.networkTargets, capabilities.externalNetwork); if (!decision.ok) return deny(decision.reason); }
  for (const request of metadata.effects) {
    if (!filesystemPolicy) return deny("filesystem effect requires an effective filesystem policy");
    const decision = authorizeFilesystemOperation(filesystemPolicy, request); filesystem.push(decision); if (!decision.ok) return deny(decision.reason);
  }
  return Object.freeze({ ok: true, reason: "all command classes and effects authorized", metadata, filesystem: Object.freeze(filesystem) });
}

export function createCommandPolicyHook(capabilities: NormalizedCapabilities, filesystemPolicy?: CompiledFilesystemPolicy): (event: { toolName?: unknown; input?: unknown }) => Promise<{ block: true; reason: string } | undefined> {
  return async (event) => {
    if (event.toolName !== "bash") return undefined;
    const input = event.input && typeof event.input === "object" && !Array.isArray(event.input) ? event.input as Record<string, unknown> : {};
    const command = typeof input.command === "string" ? input.command : "";
    const decision = authorizeCommand(command, capabilities, filesystemPolicy);
    return decision.ok ? undefined : { block: true, reason: decision.reason.slice(0, 2_048) };
  };
}
