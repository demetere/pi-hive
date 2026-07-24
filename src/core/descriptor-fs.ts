import { createHash } from "node:crypto";
import { constants, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, readdirSync, renameSync, unlinkSync, type BigIntStats } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type DescriptorEntryKind = "file" | "directory" | "symlink" | "other";
export interface DescriptorEntryStat {
  readonly kind: DescriptorEntryKind;
  readonly device: string;
  readonly inode: string;
  readonly size: bigint;
  readonly mtimeNs: bigint;
}
interface DarwinDescriptorNative {
  sourceHash(): string;
  openAt(directory: number, component: string, flags: number, mode: number): number;
  mkdirAt(directory: number, component: string, mode: number): void;
  renameAt(sourceDirectory: number, source: string, targetDirectory: number, target: string): void;
  unlinkAt(directory: number, component: string, flags: number): void;
  linkAt(sourceDirectory: number, source: string, targetDirectory: number, target: string, flags: number): void;
  statAt(directory: number, component: string): Readonly<{ kind: DescriptorEntryKind; device: string; inode: string; size: string; mtimeNs: string }>;
  descriptorPath(descriptor: number): string;
  readDirectory(descriptor: number): string[];
}

let loadedDarwinNative: DarwinDescriptorNative | undefined;
function safeComponent(value: string): string {
  if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes("\0")) throw new Error("DESCRIPTOR_COMPONENT_INVALID");
  return value;
}
function linuxDescriptorPath(descriptor: number, component?: string): string {
  const root = `/proc/self/fd/${descriptor}`;
  return component === undefined ? root : `${root}/${safeComponent(component)}`;
}
function darwinNative(): DarwinDescriptorNative {
  if (process.platform !== "darwin") throw new Error("DARWIN_DESCRIPTOR_NATIVE_PLATFORM_INVALID");
  if (loadedDarwinNative) return loadedDarwinNative;
  if (process.arch !== "arm64" && process.arch !== "x64") throw new Error(`DARWIN_DESCRIPTOR_ARCH_UNSUPPORTED: ${process.arch}`);
  const require = createRequire(import.meta.url);
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "native");
  const expected = readFileSync(join(root, "darwin-descriptor.sha256"), "utf8").trim();
  const actualSource = createHash("sha256").update(readFileSync(join(root, "darwin-descriptor.c"))).digest("hex");
  if (!/^[0-9a-f]{64}$/u.test(expected) || expected !== actualSource) throw new Error("DARWIN_DESCRIPTOR_SOURCE_IDENTITY_INVALID");
  const loaded = require(join(root, `darwin-${process.arch}.node`)) as DarwinDescriptorNative;
  if (loaded.sourceHash() !== expected) throw new Error("DARWIN_DESCRIPTOR_BINARY_IDENTITY_INVALID");
  loadedDarwinNative = loaded;
  return loadedDarwinNative;
}
function platform(): "linux" | "darwin" {
  if (process.platform === "linux" || process.platform === "darwin") return process.platform;
  throw new Error(`DESCRIPTOR_FILESYSTEM_PLATFORM_UNSUPPORTED: ${process.platform}`);
}
function kind(stat: BigIntStats): DescriptorEntryKind {
  return stat.isFile() ? "file" : stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "other";
}

export function descriptorPath(descriptor: number): string {
  return platform() === "linux" ? realpathSync.native(linuxDescriptorPath(descriptor)) : darwinNative().descriptorPath(descriptor);
}
export function openDescriptorAt(directory: number, component: string, flags: number, mode = 0): number {
  const name = safeComponent(component);
  return platform() === "linux" ? openSync(linuxDescriptorPath(directory, name), flags, mode) : darwinNative().openAt(directory, name, flags, mode);
}
export function openDirectoryAt(directory: number, component: string): number {
  return openDescriptorAt(directory, component, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}
export function mkdirAt(directory: number, component: string, mode = 0o700): void {
  const name = safeComponent(component);
  if (platform() === "linux") mkdirSync(linuxDescriptorPath(directory, name), { mode });
  else darwinNative().mkdirAt(directory, name, mode);
}
export function readDirectoryAt(directory: number): readonly string[] {
  const names = platform() === "linux" ? readdirSync(linuxDescriptorPath(directory)) : darwinNative().readDirectory(directory);
  return Object.freeze(names.filter((name) => name !== "." && name !== "..").map(safeComponent));
}
export function statAt(directory: number, component: string): DescriptorEntryStat {
  const name = safeComponent(component);
  if (platform() === "darwin") {
    const stat = darwinNative().statAt(directory, name);
    return Object.freeze({ kind: stat.kind, device: stat.device, inode: stat.inode, size: BigInt(stat.size), mtimeNs: BigInt(stat.mtimeNs) });
  }
  const stat = lstatSync(linuxDescriptorPath(directory, name), { bigint: true });
  return Object.freeze({ kind: kind(stat), device: String(stat.dev), inode: String(stat.ino), size: stat.size, mtimeNs: stat.mtimeNs });
}
export function renameAt(sourceDirectory: number, source: string, targetDirectory: number, target: string): void {
  const sourceName = safeComponent(source); const targetName = safeComponent(target);
  if (platform() === "linux") renameSync(linuxDescriptorPath(sourceDirectory, sourceName), linuxDescriptorPath(targetDirectory, targetName));
  else darwinNative().renameAt(sourceDirectory, sourceName, targetDirectory, targetName);
}
export function unlinkAt(directory: number, component: string): void {
  const name = safeComponent(component);
  if (platform() === "linux") unlinkSync(linuxDescriptorPath(directory, name));
  else darwinNative().unlinkAt(directory, name, 0);
}
export function linkAt(sourceDirectory: number, source: string, targetDirectory: number, target: string): void {
  const sourceName = safeComponent(source); const targetName = safeComponent(target);
  if (platform() === "linux") linkSync(linuxDescriptorPath(sourceDirectory, sourceName), linuxDescriptorPath(targetDirectory, targetName));
  else darwinNative().linkAt(sourceDirectory, sourceName, targetDirectory, targetName, 0);
}
