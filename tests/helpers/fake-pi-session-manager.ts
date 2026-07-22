import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

let nextSessionId = 0;
let nextEntryId = 0;

/**
 * Test double for the Pi 0.80 SessionManager surface used by linked-session
 * navigation. Session creation is deliberately deferred until `_rewriteFile`,
 * matching Pi's no-assistant transcript behavior.
 */
export class FakePiSessionManager {
  private sessionId = "";
  private sessionFile: string | undefined;
  private readonly sessionDir: string;
  private readonly cwd: string;
  private entries: Array<Record<string, unknown>> = [];
  flushed = false;

  private constructor(cwd: string, sessionDir: string, options?: { parentSession?: string }) {
    this.cwd = resolve(cwd);
    this.sessionDir = resolve(sessionDir);
    mkdirSync(this.sessionDir, { recursive: true });
    this.newSession(options);
  }

  static create(cwd: string, sessionDir: string, options?: { parentSession?: string }): FakePiSessionManager {
    return new FakePiSessionManager(cwd, sessionDir, options);
  }

  static open(path: string): FakePiSessionManager {
    const entries = readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const header = entries[0];
    if (header?.type !== "session" || typeof header.cwd !== "string" || typeof header.id !== "string") throw new Error("Invalid fake Pi session transcript");
    const manager = new FakePiSessionManager(header.cwd, dirname(path));
    manager.sessionId = header.id;
    manager.sessionFile = resolve(path);
    manager.entries = entries;
    manager.flushed = true;
    return manager;
  }

  newSession(options?: { id?: string; parentSession?: string }): string {
    this.sessionId = options?.id ?? `fake-pi-session-${++nextSessionId}`;
    this.sessionFile = join(this.sessionDir, `${this.sessionId}.jsonl`);
    this.entries = [{
      type: "session",
      version: 3,
      id: this.sessionId,
      timestamp: new Date().toISOString(),
      cwd: this.cwd,
      ...(options?.parentSession === undefined ? {} : { parentSession: options.parentSession }),
    }];
    this.flushed = false;
    return this.sessionFile;
  }

  getCwd(): string { return this.cwd; }
  getSessionDir(): string { return this.sessionDir; }
  getSessionId(): string { return this.sessionId; }
  getSessionFile(): string | undefined { return this.sessionFile; }
  getEntries(): Array<Record<string, unknown>> { return this.entries.slice(1); }
  isPersisted(): boolean { return true; }

  appendSessionInfo(name: string): string {
    return this.append({ type: "session_info", name });
  }

  appendCustomEntry(customType: string, data?: unknown): string {
    return this.append({ type: "custom", customType, data });
  }

  appendMessage(message: unknown): string {
    return this.append({ type: "message", message });
  }

  _rewriteFile(): void {
    if (!this.sessionFile) throw new Error("Fake Pi session has no transcript path");
    writeFileSync(this.sessionFile, `${this.entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  }

  private append(entry: Record<string, unknown>): string {
    const id = `fake-pi-entry-${++nextEntryId}`;
    this.entries.push({ ...entry, id, parentId: null, timestamp: new Date().toISOString() });
    if (this.flushed) this._rewriteFile();
    return id;
  }
}
