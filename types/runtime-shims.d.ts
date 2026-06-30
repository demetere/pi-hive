declare const process: any;
declare const Buffer: any;
declare const Bun: any;
declare const __dirname: string;
declare const console: any;
declare function setInterval(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): any;
declare function setTimeout(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): any;
declare function clearInterval(id: any): void;
declare function clearTimeout(id: any): void;
declare function queueMicrotask(callback: () => void): void;
declare class TextEncoder { encode(input?: string): Uint8Array; }
declare class Uint8Array {}
declare class ReadableStream<T = any> { constructor(source?: any); }
declare interface ReadableStreamDefaultController<T = any> { enqueue(chunk?: T): void; }
declare class Response {
  constructor(body?: any, init?: any);
  static json(data: any, init?: any): Response;
}
declare class URL { constructor(input: string, base?: string); pathname: string; searchParams: any; protocol: string; host: string; origin: string; }
declare namespace NodeJS { type Signals = string; }
interface ImportMeta { dir: string; url: string; }

declare module "node:fs" {
  export const constants: any;
  export type FSWatcher = any;
  export type Stats = any;
  export function appendFileSync(...args: any[]): any;
  export function closeSync(...args: any[]): any;
  export function copyFileSync(...args: any[]): any;
  export function existsSync(...args: any[]): any;
  export function mkdirSync(...args: any[]): any;
  export function mkdtempSync(...args: any[]): any;
  export function openSync(...args: any[]): any;
  export function readFileSync(...args: any[]): any;
  export function readSync(...args: any[]): any;
  export function readdirSync(...args: any[]): any;
  export function renameSync(...args: any[]): any;
  export function rmSync(...args: any[]): any;
  export function statSync(...args: any[]): any;
  export function unwatchFile(...args: any[]): any;
  export function watch(...args: any[]): any;
  export function watchFile(...args: any[]): any;
  export function writeFileSync(...args: any[]): any;
}
declare module "node:fs/promises" { export function open(...args: any[]): Promise<any>; }
declare module "node:path" { export function basename(...args: any[]): string; export function dirname(...args: any[]): string; export function extname(...args: any[]): string; export function join(...args: any[]): string; export function relative(...args: any[]): string; export function resolve(...args: any[]): string; }
declare module "node:child_process" { export type ChildProcess = any; export type SpawnOptions = any; export function execFileSync(...args: any[]): any; export function execSync(...args: any[]): any; export function spawn(...args: any[]): any; }
declare module "node:crypto" { export function randomUUID(): string; }
declare module "node:os" { export function homedir(): string; export function tmpdir(): string; }
declare module "node:url" { export function fileURLToPath(url: string): string; }
declare module "node:assert/strict" { const assert: any; export default assert; export const equal: any; export const deepEqual: any; export const ok: any; export const match: any; export const throws: any; }
declare module "node:test" { export function test(name: string, fn: (...args: any[]) => any): void; }
declare module "bun:sqlite" { export class Database { constructor(path: string); run(...args: any[]): any; query(...args: any[]): any; transaction(fn: any): any; } }

declare module "@earendil-works/pi-coding-agent" {
  export type ExtensionContext = any;
  export type ExtensionAPI = any;
}

declare module "@earendil-works/pi-tui" {
  export const Key: any;
  export const CURSOR_MARKER: string;
  export class Text { constructor(text: string, x?: number, y?: number); }
  export function truncateToWidth(text: string, width: number, suffix?: string): string;
  export function visibleWidth(text: string): number;
  export function matchesKey(data: string, key: any): boolean;
}

declare module "typebox" {
  export const Type: any;
  export type Static<T> = any;
}
