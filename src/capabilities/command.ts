import type { CompiledFilesystemPolicy, FilesystemAuthorizationDecision } from "./filesystem";
import { authorizeFilesystemOperation, recursiveFilesystemEffectProtectedKind } from "./filesystem";
import { authorizeNetworkTargets } from "./network";
import type { FilesystemOperation, NormalizedCapabilities, ShellCapability } from "./types";

export const COMMAND_POLICY_VERSION = "pi-hive-command-policy-v1";
const MAX_COMMAND_BYTES = 32_768;
const MAX_TOKENS = 256;
const MAX_EFFECTS = 64;

export interface CommandEffect { readonly operation: FilesystemOperation; readonly path: string; readonly recursive?: true }
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
const TRUSTED_COMMAND_METADATA = new WeakSet<object>();
function trustCommandMetadata(value: CommandAttemptMetadata): CommandAttemptMetadata {
  TRUSTED_COMMAND_METADATA.add(value);
  return value;
}
/** Only metadata objects emitted by this module are trusted for retry/effect classification. */
export function isTrustedCommandAttemptMetadata(value: unknown): value is CommandAttemptMetadata {
  return typeof value === "object" && value !== null && TRUSTED_COMMAND_METADATA.has(value);
}

export interface CommandAuthorization {
  readonly ok: boolean;
  readonly reason: string;
  readonly metadata: CommandAttemptMetadata;
  readonly filesystem: readonly FilesystemAuthorizationDecision[];
}

function tokenize(command: string): { tokens: string[]; compound: boolean } | undefined {
  if (typeof command !== "string" || !command.trim() || Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES || command.includes("\0")) return undefined;
  const tokens: string[] = []; let current = ""; let tokenStarted = false; let quote = ""; let escaped = false; let compound = false;
  const push = () => { if (tokenStarted) { tokens.push(current); current = ""; tokenStarted = false; } };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) { current += character; tokenStarted = true; escaped = false; continue; }
    if (character === "\\" && quote !== "'") { tokenStarted = true; escaped = true; continue; }
    if (quote) { if (character === quote) quote = ""; else { if (quote === '"' && (character === "$" || character === "`")) compound = true; current += character; } continue; }
    if (character === "'" || character === '"') { tokenStarted = true; quote = character; continue; }
    if (/\s/u.test(character)) { if (character === "\n" || character === "\r") compound = true; push(); continue; }
    if (";|&<>`$".includes(character)) compound = true;
    current += character; tokenStarted = true;
  }
  if (quote || escaped) return undefined;
  push();
  if (tokens.length === 0 || tokens.length > MAX_TOKENS) return undefined;
  return { tokens, compound };
}
const CLASS_ORDER: readonly ShellCapability[] = ["inspect", "test", "build", "package", "mutate", "execute-code"];
function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] { return Object.freeze([...new Set(values)].sort()); }
function orderedClasses(values: readonly ShellCapability[]): readonly ShellCapability[] { const set = new Set(values); return Object.freeze(CLASS_ORDER.filter((value) => set.has(value))); }
function effect(operation: FilesystemOperation, path: string, recursive = false): CommandEffect {
  return Object.freeze({ operation, path, ...(recursive ? { recursive: true as const } : {}) });
}
function hasPathShape(value: string): boolean { return value === "." || value.includes("/") || value.startsWith("."); }
function remoteUrl(value: string): boolean { return /^https?:\/\//u.test(value); }
function shortOptionHas(token: string, sought: string, valueOptions: ReadonlySet<string> = new Set()): boolean {
  if (!token.startsWith("-") || token.startsWith("--") || token === "-") return false;
  for (const option of token.slice(1)) {
    if (option === sought) return true;
    if (valueOptions.has(option)) return false;
  }
  return false;
}
interface SearchOperands { readonly paths: readonly string[]; readonly recursive: boolean; readonly followsSymlinks: boolean; readonly valid: boolean }
interface RecursiveOperands { readonly paths: readonly string[]; readonly recursive: boolean; readonly followsSymlinks: boolean; readonly valid: boolean }
function searchOperands(tokens: readonly string[], executable: "grep" | "rg"): SearchOperands {
  const grepLongValues = new Set(["--after-context", "--before-context", "--binary-files", "--context", "--directories", "--devices", "--exclude", "--exclude-dir", "--exclude-from", "--file", "--group-separator", "--include", "--label", "--max-count", "--regexp"]);
  const rgLongValues = new Set(["--after-context", "--before-context", "--colors", "--context", "--context-separator", "--encoding", "--engine", "--field-context-separator", "--field-match-separator", "--file", "--glob", "--hostname-bin", "--hyperlink-format", "--iglob", "--ignore-file", "--max-columns", "--max-count", "--max-depth", "--max-filesize", "--path-separator", "--pre", "--pre-glob", "--regexp", "--replace", "--sort", "--sortr", "--type", "--type-add", "--type-clear", "--type-not"]);
  const longValues = executable === "grep" ? grepLongValues : rgLongValues;
  const grepLongFlags = new Set([
    "--basic-regexp", "--binary", "--byte-offset", "--dereference-recursive", "--extended-regexp", "--fixed-strings",
    "--help", "--ignore-case", "--initial-tab", "--invert-match", "--line-buffered", "--line-number", "--no-filename",
    "--no-group-separator", "--no-ignore-case", "--no-messages", "--null", "--null-data", "--only-matching",
    "--perl-regexp", "--quiet", "--recursive", "--silent", "--text", "--version", "--with-filename", "--word-regexp",
    "--line-regexp", "--color", "--colour",
  ]);
  const grepShortFlags = new Set(["E", "F", "G", "P", "H", "I", "R", "T", "U", "V", "Z", "a", "b", "h", "i", "l", "L", "n", "o", "q", "r", "s", "v", "w", "x", "y", "z"]);
  const shortValues = executable === "grep" ? new Set(["A", "B", "C", "D", "d", "e", "f", "m"])
    : new Set(["A", "B", "C", "E", "M", "T", "e", "f", "g", "j", "m", "r", "t"]);
  const positional: string[] = [];
  let explicitPattern = false;
  let followsSymlinks = false;
  let recursiveDirectories = false;
  let valid = true;
  const acceptDirectoryMode = (value: string | undefined): void => {
    if (!value || !["read", "recurse", "skip"].includes(value)) valid = false;
    else if (value === "recurse") recursiveDirectories = true;
  };
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") { positional.push(...tokens.slice(index + 1)); break; }
    if (token.startsWith("--")) {
      const name = token.split("=", 1)[0];
      if (name === "--regexp") explicitPattern = true;
      if (executable === "grep" && !longValues.has(name) && !grepLongFlags.has(name)) valid = false;
      if (executable === "grep" && grepLongFlags.has(name) && token.includes("=") && name !== "--color" && name !== "--colour") valid = false;
      if (executable === "rg" && name === "--follow" || executable === "grep" && name === "--dereference-recursive") followsSymlinks = true;
      if (executable === "grep" && name === "--directories") {
        const attached = token.includes("=") ? token.slice(token.indexOf("=") + 1) : undefined;
        const value = attached ?? tokens[index + 1];
        acceptDirectoryMode(value);
        if (attached === undefined && value !== undefined) index += 1;
        continue;
      }
      if (longValues.has(name) && !token.includes("=")) {
        if (tokens[index + 1] === undefined) valid = false;
        else index += 1;
      }
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      if (executable === "grep") {
        for (let offset = 1; offset < token.length; offset += 1) {
          const option = token[offset];
          if (shortValues.has(option)) break;
          if (!grepShortFlags.has(option)) valid = false;
        }
      }
      if (shortOptionHas(token, "e", shortValues)) explicitPattern = true;
      if (executable === "rg" && shortOptionHas(token, "L", shortValues) || executable === "grep" && shortOptionHas(token, "R", shortValues)) followsSymlinks = true;
      for (let offset = 1; offset < token.length; offset += 1) if (shortValues.has(token[offset])) {
        if (token[offset] === "e") explicitPattern = true;
        const attached = token.slice(offset + 1) || undefined;
        const value = attached ?? tokens[index + 1];
        if (executable === "grep" && token[offset] === "d") acceptDirectoryMode(value);
        if (attached === undefined) {
          if (value === undefined) valid = false;
          else index += 1;
        }
        break;
      }
      continue;
    }
    positional.push(token);
  }
  const recursive = executable === "rg" || tokens.some((token) => token === "-r" || token === "--recursive" || shortOptionHas(token, "r", shortValues)) || followsSymlinks || recursiveDirectories;
  return { paths: explicitPattern ? positional : positional.slice(1), recursive, followsSymlinks, valid };
}
function listOperands(tokens: readonly string[]): RecursiveOperands {
  const longFlags = new Set([
    "--all", "--almost-all", "--author", "--classify", "--dereference-command-line", "--dereference-command-line-symlink-to-dir",
    "--directory", "--escape", "--file-type", "--group-directories-first", "--help", "--hide-control-chars", "--human-readable",
    "--inode", "--literal", "--no-group", "--numeric-uid-gid", "--quote-name", "--recursive", "--reverse", "--show-control-chars",
    "--si", "--size", "--version", "--zero",
  ]);
  const longValues = new Set(["--block-size", "--format", "--hide", "--ignore", "--indicator-style", "--quoting-style", "--sort", "--tabsize", "--time", "--time-style", "--width"]);
  const optionalLongValues = new Set(["--color", "--hyperlink"]);
  const shortFlags = new Set(["1", "A", "B", "C", "D", "F", "G", "H", "L", "N", "Q", "R", "S", "U", "X", "Z", "a", "b", "c", "d", "f", "g", "h", "i", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "x"]);
  const shortValues = new Set(["I", "T", "w"]);
  const paths: string[] = [];
  let recursive = false; let followsSymlinks = false; let valid = true;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") { paths.push(...tokens.slice(index + 1)); break; }
    if (token.startsWith("--")) {
      const equal = token.indexOf("=");
      const name = equal >= 0 ? token.slice(0, equal) : token;
      if (!longFlags.has(name) && !longValues.has(name) && !optionalLongValues.has(name)) { valid = false; continue; }
      if (name === "--recursive") recursive = true;
      if (name === "--dereference-command-line" || name === "--dereference-command-line-symlink-to-dir") followsSymlinks = true;
      if (longFlags.has(name) && equal >= 0) valid = false;
      if (longValues.has(name) && equal < 0) {
        if (tokens[index + 1] === undefined) valid = false;
        else index += 1;
      }
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      for (let offset = 1; offset < token.length; offset += 1) {
        const option = token[offset];
        if (shortValues.has(option)) {
          if (offset === token.length - 1) {
            if (tokens[index + 1] === undefined) valid = false;
            else index += 1;
          }
          break;
        }
        if (!shortFlags.has(option)) valid = false;
        if (option === "R") recursive = true;
        if (option === "H" || option === "L") followsSymlinks = true;
      }
      continue;
    }
    paths.push(token);
  }
  return { paths, recursive, followsSymlinks, valid };
}
function copyOperands(tokens: readonly string[]): RecursiveOperands {
  const longFlags = new Set(["--archive", "--dereference", "--force", "--interactive", "--link", "--no-clobber", "--no-dereference", "--one-file-system", "--recursive", "--symbolic-link", "--verbose"]);
  const shortFlags = new Set(["H", "L", "P", "R", "a", "d", "f", "i", "l", "n", "p", "r", "s", "u", "v", "x"]);
  const paths: string[] = [];
  let recursive = false; let followsSymlinks = false; let valid = true;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") { paths.push(...tokens.slice(index + 1)); break; }
    if (token.startsWith("--")) {
      const name = token.split("=", 1)[0];
      if (!longFlags.has(name) || token.includes("=")) { valid = false; continue; }
      if (name === "--archive" || name === "--recursive") recursive = true;
      if (name === "--dereference") followsSymlinks = true;
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      for (const option of token.slice(1)) {
        if (!shortFlags.has(option)) valid = false;
        if (option === "R" || option === "r" || option === "a") recursive = true;
        if (option === "H" || option === "L") followsSymlinks = true;
      }
      continue;
    }
    paths.push(token);
  }
  return { paths, recursive, followsSymlinks, valid };
}
interface ClosedOperands { readonly paths: readonly string[]; readonly valid: boolean }
interface RmOperands extends ClosedOperands { readonly recursive: boolean }
function rmOperands(tokens: readonly string[]): RmOperands {
  const longFlags = new Set(["--dir", "--force", "--help", "--no-preserve-root", "--one-file-system", "--recursive", "--verbose", "--version"]);
  const shortFlags = new Set(["I", "R", "d", "f", "i", "r", "v"]);
  const paths: string[] = [];
  let recursive = false; let valid = true; let options = true;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (options && token === "--") { options = false; continue; }
    if (options && token.startsWith("--")) {
      const equal = token.indexOf("=");
      const name = equal >= 0 ? token.slice(0, equal) : token;
      const value = equal >= 0 ? token.slice(equal + 1) : undefined;
      if (longFlags.has(name)) {
        if (value !== undefined) valid = false;
        if (name === "--recursive") recursive = true;
      } else if (name === "--interactive") {
        if (value !== undefined && !["always", "never", "once"].includes(value)) valid = false;
      } else if (name === "--preserve-root") {
        if (value !== undefined && value !== "all") valid = false;
      } else valid = false;
      continue;
    }
    if (options && token.startsWith("-") && token !== "-") {
      for (const option of token.slice(1)) {
        if (!shortFlags.has(option)) valid = false;
        if (option === "r" || option === "R") recursive = true;
      }
      continue;
    }
    paths.push(token);
  }
  return { paths, recursive, valid };
}

function wcOperands(tokens: readonly string[]): ClosedOperands {
  const longFlags = new Set(["--bytes", "--chars", "--help", "--lines", "--max-line-length", "--version", "--words"]);
  const shortFlags = new Set(["L", "c", "l", "m", "w"]);
  const totals = new Set(["always", "auto", "never", "only"]);
  const paths: string[] = [];
  let valid = true; let options = true;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (options && token === "--") { options = false; continue; }
    if (options && token.startsWith("--")) {
      const equal = token.indexOf("=");
      const name = equal >= 0 ? token.slice(0, equal) : token;
      let value = equal >= 0 ? token.slice(equal + 1) : undefined;
      if (longFlags.has(name)) {
        if (value !== undefined) valid = false;
      } else if (name === "--total") {
        value ??= tokens[++index];
        if (value === undefined || !totals.has(value)) valid = false;
      } else valid = false;
      continue;
    }
    if (options && token.startsWith("-") && token !== "-") {
      for (const option of token.slice(1)) if (!shortFlags.has(option)) valid = false;
      continue;
    }
    paths.push(token);
  }
  return { paths, valid };
}

interface TouchOperands extends ClosedOperands { readonly references: readonly string[] }
function touchOperands(tokens: readonly string[]): TouchOperands {
  const longFlags = new Set(["--help", "--no-create", "--no-dereference", "--version"]);
  const longValues = new Set(["--date", "--reference", "--time"]);
  const shortFlags = new Set(["a", "c", "f", "h", "m"]);
  const shortValues = new Set(["d", "r", "t"]);
  const paths: string[] = []; const references: string[] = [];
  let valid = true; let options = true;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (options && token === "--") { options = false; continue; }
    if (options && token.startsWith("--")) {
      const equal = token.indexOf("=");
      const name = equal >= 0 ? token.slice(0, equal) : token;
      let value = equal >= 0 ? token.slice(equal + 1) : undefined;
      if (longFlags.has(name)) {
        if (value !== undefined) valid = false;
      } else if (longValues.has(name)) {
        value ??= tokens[++index];
        if (value === undefined || value === "") valid = false;
        else if (name === "--reference") references.push(value);
      } else valid = false;
      continue;
    }
    if (options && token.startsWith("-") && token !== "-") {
      for (let offset = 1; offset < token.length; offset += 1) {
        const option = token[offset];
        if (shortValues.has(option)) {
          const attached = token.slice(offset + 1);
          const value = attached || tokens[++index];
          if (value === undefined || value === "") valid = false;
          else if (option === "r") references.push(value);
          break;
        }
        if (!shortFlags.has(option)) valid = false;
      }
      continue;
    }
    paths.push(token);
  }
  return { paths, references, valid };
}

interface GitStatusOptions { readonly valid: boolean; readonly emitsBlobOrDiff: boolean }
function gitStatusOptions(tokens: readonly string[], subcommandIndex: number): GitStatusOptions {
  const longFlags = new Set([
    "--ahead-behind", "--branch", "--help", "--long", "--no-ahead-behind", "--no-branch", "--no-long",
    "--no-null", "--no-renames", "--no-short", "--no-show-stash", "--no-verbose", "--null", "--renames",
    "--short", "--show-stash", "--verbose",
  ]);
  const optionalLongValues = new Set([
    "--column", "--find-renames", "--ignore-submodules", "--ignored", "--no-column", "--no-find-renames",
    "--no-ignore-submodules", "--no-ignored", "--no-porcelain", "--no-untracked-files", "--porcelain", "--untracked-files",
  ]);
  const shortFlags = new Set(["b", "s", "z"]);
  let valid = subcommandIndex >= 0; let emitsBlobOrDiff = false; let options = true;
  for (let index = subcommandIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (options && token === "--") { options = false; continue; }
    if (!options || !token.startsWith("-") || token === "-") continue;
    if (token.startsWith("--")) {
      const equal = token.indexOf("=");
      const name = equal >= 0 ? token.slice(0, equal) : token;
      const value = equal >= 0 ? token.slice(equal + 1) : undefined;
      if (longFlags.has(name)) {
        if (value !== undefined) valid = false;
        if (name === "--verbose") emitsBlobOrDiff = true;
      } else if (optionalLongValues.has(name)) {
        if (value === "") valid = false;
      } else valid = false;
      continue;
    }
    for (let offset = 1; offset < token.length; offset += 1) {
      const option = token[offset];
      if (option === "v") { emitsBlobOrDiff = true; continue; }
      if (option === "u" || option === "M") break;
      if (!shortFlags.has(option)) valid = false;
    }
  }
  return { valid, emitsBlobOrDiff };
}

function sedSubstitutionProgramIsProven(program: string): boolean {
  if (program[0] !== "s" || program.length < 4 || program.includes("\n") || program.includes("\r") || /[A-Za-z0-9\\]/u.test(program[1])) return false;
  const delimiter = program[1];
  const sectionEnd = (start: number): number | undefined => {
    let escaped = false;
    for (let index = start; index < program.length; index += 1) {
      const character = program[index];
      if (escaped) { escaped = false; continue; }
      if (character === "\\") { escaped = true; continue; }
      if (character === delimiter) return index + 1;
    }
    return undefined;
  };
  const patternEnd = sectionEnd(2);
  if (patternEnd === undefined) return false;
  const replacementEnd = sectionEnd(patternEnd);
  if (replacementEnd === undefined) return false;
  const flags = program.slice(replacementEnd);
  for (let index = 0; index < flags.length;) {
    const character = flags[index];
    if ("gpIiMm".includes(character)) { index += 1; continue; }
    if (character >= "1" && character <= "9") {
      index += 1;
      while (index < flags.length && flags[index] >= "0" && flags[index] <= "9") index += 1;
      continue;
    }
    return false;
  }
  return true;
}
function sedInlineEditOperands(tokens: readonly string[]): { readonly paths: readonly string[]; readonly valid: boolean } {
  const programs: string[] = []; const positional: string[] = [];
  let inPlace = false; let options = true; let valid = true;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (options && token === "--") { options = false; continue; }
    if (options && token.startsWith("-") && token !== "-") {
      if (token === "-i" || token === "--in-place") {
        if (inPlace) valid = false;
        inPlace = true;
        // BSD sed accepts an optional backup suffix as the next argv. Consume
        // only the unambiguous no-backup form followed by an explicit program.
        if (token === "-i" && tokens[index + 1] === "" && ["-e", "--expression"].includes(tokens[index + 2] ?? "")) index += 1;
        continue;
      }
      if (["-E", "-r", "--regexp-extended", "-n", "--quiet", "--silent"].includes(token)) continue;
      if (token === "-e" || token === "--expression") {
        const program = tokens[++index];
        if (program === undefined) valid = false; else programs.push(program);
        continue;
      }
      if (token.startsWith("--expression=")) {
        const program = token.slice("--expression=".length);
        if (!program) valid = false; else programs.push(program);
        continue;
      }
      if (token.startsWith("-e") && token.length > 2) { programs.push(token.slice(2)); continue; }
      valid = false;
      continue;
    }
    positional.push(token);
  }
  if (programs.length === 0) {
    const program = positional.shift();
    if (program === undefined) valid = false; else programs.push(program);
  }
  if (!inPlace || programs.length === 0 || positional.length === 0 || positional.includes("-") || !programs.every(sedSubstitutionProgramIsProven)) valid = false;
  return { paths: positional, valid };
}
function findRootsAndExpression(tokens: readonly string[]): { roots: readonly string[]; expression: readonly string[]; valid: boolean; followsSymlinks: boolean } {
  let index = 1; let followsSymlinks = false;
  while (index < tokens.length) {
    const token = tokens[index];
    if (["-H", "-L", "-P"].includes(token) || /^-O[0-9]+$/u.test(token)) { if (token === "-H" || token === "-L") followsSymlinks = true; index += 1; continue; }
    if (token === "-D") { if (!tokens[index + 1]) return { roots: [], expression: [], valid: false, followsSymlinks }; index += 2; continue; }
    break;
  }
  const roots: string[] = [];
  while (index < tokens.length && !tokens[index].startsWith("-") && tokens[index] !== "!" && tokens[index] !== "(") roots.push(tokens[index++]);
  const expression = tokens.slice(index);
  if (expression.includes("-follow")) followsSymlinks = true;
  return { roots: roots.length ? roots : ["."], expression, valid: true, followsSymlinks };
}
function gitEmitsBlobOrDiff(subcommand: string, tokens: readonly string[]): boolean {
  if (subcommand === "status") return tokens.some((token) => token === "--verbose" || token.startsWith("--verbose=") || shortOptionHas(token, "v"));
  if (subcommand !== "log") return false;
  const contentOptions = new Set([
    "--binary", "--cc", "--check", "--color-words", "--combined-all-paths", "--dd", "--diff-merges", "--ext-diff",
    "--full-diff", "--no-diff-merges", "--patch", "--patch-with-raw", "--patch-with-stat", "--remerge-diff", "--unified", "--word-diff",
  ]);
  return tokens.some((token) => {
    const name = token.split("=", 1)[0];
    return contentOptions.has(name) || name === "--word-diff-regex" || /^-U(?:[0-9]+)?$/u.test(token)
      || shortOptionHas(token, "p") || shortOptionHas(token, "u") || shortOptionHas(token, "c") || token === "-m";
  });
}
function gitUsesContentSearch(tokens: readonly string[]): boolean {
  return tokens.some((token) => {
    if (shortOptionHas(token, "S") || shortOptionHas(token, "G")) return true;
    const name = token.split("=", 1)[0];
    return name.startsWith("--pickaxe-") || name === "--find-object";
  });
}
function remoteGit(tokens: readonly string[]): boolean {
  const sub = tokens.find((token, index) => index > 0 && !token.startsWith("-"));
  return ["clone", "fetch", "pull", "push", "ls-remote"].includes(sub ?? "") || tokens.some((token) => /^(?:https?|ssh|git):\/\//u.test(token) || token.includes("@") && token.includes(":"));
}
function gitSubcommand(tokens: readonly string[]): string {
  return tokens.find((token, index) => index > 0 && !token.startsWith("-") && tokens[index - 1] !== "-c") ?? "";
}
function curlProtocolsRestrictedToHttp(value: string): boolean {
  if (!value.startsWith("=")) return false;
  const protocols = value.slice(1).split(",");
  return protocols.length > 0 && protocols.every((protocol) => protocol === "http" || protocol === "https");
}
function networkTargets(tokens: readonly string[], executable: string, gitRemote: boolean, classifiedTargets: readonly string[]): string[] {
  const results: string[] = [...classifiedTargets];
  if (["ssh", "scp", "gh"].includes(executable)) for (const token of tokens.slice(1)) {
    if (remoteUrl(token) || /^(?:[^/@:]+@)?[^/:]+:.+/u.test(token)) results.push(token);
  }
  if (gitRemote) {
    for (const token of tokens.slice(1)) if (/^(?:https?|ssh|git):\/\//u.test(token) || token.includes("@") && token.includes(":")) results.push(token);
    if (results.length === 0) results.push("https://git-remote.invalid");
  }
  if (["npm", "pnpm", "yarn", "bun", "pip", "pip3"].includes(executable) && ["install", "add", "publish"].includes(tokens[1] ?? "")) results.push("https://registry.npmjs.org");
  return [...new Set(results)].slice(0, 32);
}

export function analyzeCommand(command: string): CommandAttemptMetadata {
  const parsed = tokenize(command);
  const invalid = (reason: string): CommandAttemptMetadata => trustCommandMetadata(Object.freeze({ version: COMMAND_POLICY_VERSION, command: String(command).slice(0, MAX_COMMAND_BYTES), classes: Object.freeze([]), effects: Object.freeze([]), networkTargets: Object.freeze([]), git: false, mutating: false, idempotency: "unknown", processTreeOwned: true, acceptedRisks: Object.freeze([]), valid: false, reason }));
  if (!parsed) return invalid("command is malformed or exceeds policy bounds");
  const { tokens, compound } = parsed; const executable = tokens[0];
  const classes: ShellCapability[] = []; const effects: CommandEffect[] = []; const risks: Array<"bare-filename-read" | "interpreter-hidden-write"> = [];
  const classifiedNetworkTargets: string[] = [];
  let git = false; let mutating = false; let known = false; let opaque = false; let gitRemote = false; let forbiddenAlias = false; let ambiguousEffects = false;

  if (["pwd", "ls", "cat", "head", "tail", "less", "more", "grep", "rg", "find", "stat", "wc", "which", "type", "echo", "printf"].includes(executable)) { classes.push("inspect"); known = true; }
  if (["ls", "cat", "head", "tail", "less", "more", "stat", "wc"].includes(executable)) {
    if (executable === "ls") {
      const parsedList = listOperands(tokens);
      if (!parsedList.valid || parsedList.recursive && parsedList.followsSymlinks) ambiguousEffects = true;
      for (const path of parsedList.paths) effects.push(effect("read", path, parsedList.recursive));
      if (parsedList.recursive && parsedList.paths.length === 0) effects.push(effect("read", ".", true));
    } else if (executable === "wc") {
      const parsedWc = wcOperands(tokens);
      if (!parsedWc.valid) ambiguousEffects = true;
      for (const path of parsedWc.paths) if (hasPathShape(path)) effects.push(effect("read", path));
    } else {
      const operands = tokens.slice(1).filter((token) => !token.startsWith("-") && hasPathShape(token));
      for (const path of operands) effects.push(effect("read", path));
    }
  }
  if (executable === "grep" || executable === "rg") {
    const parsedSearch = searchOperands(tokens, executable);
    for (const path of parsedSearch.paths) effects.push(effect("read", path, parsedSearch.recursive));
    if (parsedSearch.recursive && parsedSearch.paths.length === 0) effects.push(effect("read", ".", true));
    if (parsedSearch.followsSymlinks || !parsedSearch.valid) ambiguousEffects = true;
    if (tokens.some((token) => token === "-f" || token.startsWith("-f") || token === "--file" || token.startsWith("--file=") || token === "--exclude-from" || token.startsWith("--exclude-from=")
      || token === "--ignore-file" || token.startsWith("--ignore-file=") || token === "--pre" || token.startsWith("--pre=")
      || token === "--hostname-bin" || token.startsWith("--hostname-bin="))) ambiguousEffects = true;
  }
  if (["less", "more"].includes(executable)) ambiguousEffects = true;
  if (executable === "find") {
    const parsedFind = findRootsAndExpression(tokens);
    const deleting = parsedFind.expression.includes("-delete");
    const unprovable = parsedFind.expression.some((token) => ["-exec", "-execdir", "-ok", "-okdir", "-files0-from", "-fprint", "-fprint0", "-fprintf", "-fls"].includes(token));
    if (!parsedFind.valid || parsedFind.followsSymlinks || unprovable) ambiguousEffects = true;
    for (const path of parsedFind.roots) effects.push(effect(deleting ? "delete" : "read", path, true));
    for (let index = 0; index < parsedFind.expression.length; index += 1) {
      const token = parsedFind.expression[index];
      const newer = /^-(?:[ac]newer|newer(?:[aBcm][aBcmt])?)$/u.exec(token);
      if (token === "-samefile" || newer) {
        const reference = parsedFind.expression[index + 1];
        if (!reference) ambiguousEffects = true;
        else {
          if (token === "-samefile" || !token.endsWith("t") || hasPathShape(reference)) effects.push(effect("read", reference));
          index += 1;
        }
      }
    }
  }
  if (["node", "python", "python3", "ruby", "perl", "sh", "bash", "zsh", "deno", "tsx"].includes(executable) || executable.startsWith("./")) { classes.push("execute-code"); known = true; opaque = true; }
  if (["pytest", "jest", "vitest"].includes(executable) || ["npm", "pnpm", "yarn", "bun", "cargo", "go", "just"].includes(executable) && /^(?:run-)?test|^test/u.test(tokens[1] ?? "")) { classes.push("test", "execute-code"); known = true; opaque = true; }
  if (["tsc", "make", "cmake"].includes(executable) || ["npm", "pnpm", "yarn", "bun", "cargo", "go", "just"].includes(executable) && /build|compile/u.test(tokens.slice(1, 3).join(" "))) { classes.push("build", "execute-code"); known = true; opaque = true; }
  if (["npm", "pnpm", "yarn", "bun", "pip", "pip3"].includes(executable) && ["install", "add", "publish"].includes(tokens[1] ?? "")) { classes.push("package", "execute-code"); known = true; opaque = true; mutating = true; }
  if (["npm", "pnpm", "yarn", "bun", "just"].includes(executable) && (tokens[1] === "run" || executable === "just") && !classes.includes("test") && !classes.includes("build")) { classes.push("execute-code"); known = true; opaque = true; }
  if (executable === "rm") {
    classes.push("mutate"); known = true; mutating = true;
    const parsedRm = rmOperands(tokens);
    if (!parsedRm.valid) ambiguousEffects = true;
    for (const path of parsedRm.paths) effects.push(effect("delete", path, parsedRm.recursive));
  }
  if (executable === "find" && tokens.includes("-delete")) { classes.push("mutate"); mutating = true; }
  if (["mkdir", "touch"].includes(executable)) {
    classes.push("mutate"); known = true; mutating = true;
    if (executable === "touch") {
      const parsedTouch = touchOperands(tokens);
      if (!parsedTouch.valid) ambiguousEffects = true;
      for (const reference of parsedTouch.references) effects.push(effect("read", reference));
      for (const path of parsedTouch.paths) effects.push(effect("create", path));
    } else for (const token of tokens.slice(1)) if (!token.startsWith("-")) effects.push(effect("create", token));
  }
  if (["mv", "cp"].includes(executable)) {
    classes.push("mutate"); known = true; mutating = true;
    if (executable === "cp") {
      const parsedCopy = copyOperands(tokens);
      if (!parsedCopy.valid || parsedCopy.recursive && parsedCopy.followsSymlinks) ambiguousEffects = true;
      for (const source of parsedCopy.paths.slice(0, -1)) effects.push(effect("read", source, parsedCopy.recursive));
      if (parsedCopy.paths.at(-1)) effects.push(effect("create", parsedCopy.paths.at(-1)!));
    } else {
      const args = tokens.slice(1).filter((token) => !token.startsWith("-"));
      if (args[0]) effects.push(effect("delete", args[0], true));
      if (args.at(-1)) effects.push(effect("create", args.at(-1)!));
    }
  }
  if (executable === "sed") {
    classes.push("mutate"); known = true; mutating = true;
    const parsedSed = sedInlineEditOperands(tokens);
    if (!parsedSed.valid) ambiguousEffects = true;
    for (const path of parsedSed.paths) effects.push(effect("update", path));
  }
  if (executable === "git") {
    known = true; git = true; const sub = gitSubcommand(tokens); gitRemote = remoteGit(tokens);
    const readonly = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files"]);
    if (readonly.has(sub)) classes.push("inspect");
    else { classes.push("mutate"); mutating = true; }
    forbiddenAlias = tokens.some((token) => token.startsWith("alias."));
    const subIndex = tokens.indexOf(sub);
    const separator = tokens.indexOf("--");
    const hasPathspec = separator >= 0 && separator < tokens.length - 1;
    const hasIndirectPathspec = tokens.some((token) => token === "--pathspec-from-file" || token.startsWith("--pathspec-from-file=") || token === "--output" || token.startsWith("--output=") || token === "--textconv");
    const hasRevisionPath = tokens.some((token, index) => index > 0 && !token.startsWith("http") && token.includes(":") && !token.startsWith("--format="));
    const hasGlobalConfig = subIndex > 1 && tokens.slice(1, subIndex).some((token) => token !== "--no-pager");
    const hasShapedArgument = subIndex >= 0 && tokens.slice(subIndex + 1).some((token) => !token.startsWith("-") && hasPathShape(token));
    const statusOptions = sub === "status" ? gitStatusOptions(tokens, subIndex) : undefined;
    if (["show", "diff", "clean", "rm", "mv"].includes(sub) || gitEmitsBlobOrDiff(sub, tokens) || gitUsesContentSearch(tokens)
      || statusOptions && (!statusOptions.valid || statusOptions.emitsBlobOrDiff)
      || hasPathspec || hasIndirectPathspec || hasRevisionPath || hasGlobalConfig || hasShapedArgument) ambiguousEffects = true;
    if (mutating || tokens.includes("-c") || tokens.some((token) => token.startsWith("core.hooksPath")) || ["submodule", "hook"].includes(sub)) { classes.push("execute-code"); opaque = true; }
    if (["checkout", "switch", "reset", "restore", "merge", "rebase", "pull", "submodule"].includes(sub)) { effects.push(effect("update", ".")); ambiguousEffects = true; }
  }
  if (executable === "curl") {
    classes.push("inspect"); known = true;
    const safeFlags = new Set(["--fail", "--silent", "--show-error", "--head", "--include", "--compressed", "--fail-with-body", "--insecure", "--verbose", "--no-buffer"]);
    const safeValues = new Set(["--request", "--header", "--user-agent", "--referer", "--user", "--connect-timeout", "--max-time", "--retry", "--retry-delay", "--retry-max-time", "--limit-rate", "--range", "--url"]);
    const shortValues = new Set(["-X", "-H", "-A", "-e", "-u", "-m", "-r"]);
    const localReads = new Set(["--upload-file", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--form", "--cacert", "--capath", "--cert", "--key", "--netrc-file"]);
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (remoteUrl(token)) { classifiedNetworkTargets.push(token); continue; }
      if (token === "--") {
        for (const value of tokens.slice(index + 1)) {
          if (remoteUrl(value)) classifiedNetworkTargets.push(value);
          else ambiguousEffects = true;
        }
        break;
      }
      if (safeFlags.has(token) || /^-[fsSIikvN]+$/u.test(token)) continue;
      const equal = token.startsWith("--") ? token.indexOf("=") : -1;
      const name = equal > 0 ? token.slice(0, equal) : token;
      let value = equal > 0 ? token.slice(equal + 1) : undefined;
      if (safeValues.has(name) || shortValues.has(name)) {
        value ??= tokens[++index];
        if (value === undefined || (name === "--url" && !remoteUrl(value))) ambiguousEffects = true;
        else if (name === "--url") classifiedNetworkTargets.push(value);
        else if (["-H", "--header"].includes(name) && value.startsWith("@") && value.length > 1) effects.push(effect("read", value.slice(1)));
        continue;
      }
      if (name === "--proto" || name === "--proto-redir") {
        value ??= tokens[++index];
        if (value === undefined || !curlProtocolsRestrictedToHttp(value)) ambiguousEffects = true;
        continue;
      }
      if (name === "-T" || name === "--upload-file" || name === "-d" || localReads.has(name)) {
        value ??= token.length > 2 && name === token.slice(0, 2) ? token.slice(2) : tokens[++index];
        if (value === undefined) { ambiguousEffects = true; continue; }
        const local = name === "--form" ? /(?:=@|=<)(.+)$/u.exec(value)?.[1]
          : name === "--data-urlencode" ? (() => { const at = value.indexOf("@"); return at >= 0 && !value.slice(0, at).includes("=") ? value.slice(at + 1) : undefined; })()
            : ["-d", "--data", "--data-raw", "--data-binary"].includes(name) ? /^@(.+)$/u.exec(value)?.[1]
              : value;
        if (local && local !== "-") effects.push(effect("read", local));
        continue;
      }
      if (["-o", "--output", "-O", "--remote-name", "--remote-header-name", "-K", "--config", "--trace", "--trace-ascii", "--dump-header", "--cookie-jar", "--write-out"].includes(name)
        || /^-(?:o|T|K).+/u.test(token)) {
        if (token.startsWith("-T") && token.length > 2) effects.push(effect("read", token.slice(2)));
        else ambiguousEffects = true;
        continue;
      }
      ambiguousEffects = true;
    }
    if (classifiedNetworkTargets.length === 0) ambiguousEffects = true;
  }
  if (executable === "wget") {
    classes.push("inspect"); known = true;
    let stdout = false;
    const safeFlags = new Set(["-q", "--quiet", "--no-verbose", "--spider", "--server-response", "--no-check-certificate"]);
    const safeValues = new Set(["--timeout", "--connect-timeout", "--read-timeout", "--tries", "--waitretry", "--user-agent", "--header"]);
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (remoteUrl(token)) { classifiedNetworkTargets.push(token); continue; }
      if (token === "-qO-") { stdout = true; continue; }
      if (safeFlags.has(token)) continue;
      const equal = token.startsWith("--") ? token.indexOf("=") : -1;
      const name = equal > 0 ? token.slice(0, equal) : token;
      let value = equal > 0 ? token.slice(equal + 1) : undefined;
      if (safeValues.has(name)) { value ??= tokens[++index]; if (value === undefined) ambiguousEffects = true; continue; }
      if (name === "-O" || name === "--output-document") {
        value ??= token.length > 2 && token.startsWith("-O") ? token.slice(2) : tokens[++index];
        if (value === "-") stdout = true; else ambiguousEffects = true;
        continue;
      }
      if (["--post-file", "--body-file"].includes(name)) {
        value ??= tokens[++index];
        if (!value) ambiguousEffects = true; else effects.push(effect("read", value));
        continue;
      }
      ambiguousEffects = true;
    }
    if (!stdout || classifiedNetworkTargets.length === 0) ambiguousEffects = true;
  }
  if (executable === "scp") { classes.push("inspect"); known = true; ambiguousEffects = true; }
  if (["ssh", "gh"].includes(executable)) { classes.push("inspect"); known = true; ambiguousEffects = true; }
  if (opaque) risks.push("interpreter-hidden-write");
  if (["cat", "head", "tail", "less", "more"].includes(executable) && tokens.slice(1).some((token) => !hasPathShape(token))) risks.push("bare-filename-read");
  const targets = networkTargets(tokens, executable, gitRemote, classifiedNetworkTargets);
  const pathlessGitMutation = git && ["commit", "push", "fetch"].includes(gitSubcommand(tokens));
  const pathlessMutation = mutating && effects.length === 0 && !pathlessGitMutation;
  const valid = known && !compound && !forbiddenAlias && !ambiguousEffects && !pathlessMutation && effects.length <= MAX_EFFECTS;
  return trustCommandMetadata(Object.freeze({ version: COMMAND_POLICY_VERSION, command, executable, classes: orderedClasses(classes), effects: Object.freeze(effects), networkTargets: Object.freeze(targets), git, mutating, idempotency: mutating ? "non-idempotent" : "idempotent", processTreeOwned: true, acceptedRisks: uniqueSorted(risks), valid, ...(valid ? {} : { reason: compound || forbiddenAlias ? "compound/ambiguous shell syntax" : ambiguousEffects ? "mutation effect set cannot be proven before execution" : pathlessMutation ? "pathless mutation" : "unknown or excessive command effects" }) }));
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
    if (request.recursive) {
      const protectedKind = recursiveFilesystemEffectProtectedKind(filesystemPolicy, request.path);
      if (protectedKind) return deny(`recursive filesystem effect intersects a protected ${protectedKind} path`);
    }
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
