import { closeSync, fstatSync, openSync, readSync, type Stats } from "node:fs";
import { dirname } from "node:path";
import type { ConfiguredProject } from "./manifest";
import { validateSchemaValue, WorkflowV1Schema } from "./schema";
import type { RawWorkflowV1 } from "./types";
import { parseConfigYaml, type YamlSourceMap } from "./yaml";
import { createDiagnosticCollector, sourceRange, type ConfigDiagnostic, type ConfigDiagnosticCode } from "./diagnostics";
import { resolveRegistryTarget } from "./paths";
import { WORKFLOW_LIMITS } from "./team";

export interface WorkflowDescriptorStat { size: number; isFile(): boolean; dev?: number | bigint; ino?: number | bigint }
export interface WorkflowLoadOperations {
  open?(path: string): number;
  fstat?(fd: number): WorkflowDescriptorStat;
  read?(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number;
  close?(fd: number): void;
  /** Retained only for compatibility with fault injectors; descriptor reads are authoritative. */
  stat?(path: string): Pick<Stats, "size" | "isFile">;
}
export interface LoadedWorkflowResource { status: "loaded"; id: string; source: string; rawSource: string; sourceMap: YamlSourceMap; value: RawWorkflowV1 }
export interface FailedWorkflowResource { status: "failed"; id: string; source: string; diagnostics: ConfigDiagnostic[] }
export type WorkflowResource = LoadedWorkflowResource | FailedWorkflowResource;
function fail(id: string, source: string, code: ConfigDiagnosticCode, message: string, range = sourceRange(0, 1, 1, 0, 1, 1)): FailedWorkflowResource { return { status: "failed", id, source, diagnostics: [{ code, severity: "error", message, source, range, resourceId: id }] }; }
function bytes(value: unknown): number { return Buffer.byteLength(String(value ?? ""), "utf8"); }
function metadataDiagnostics(id: string, source: string, raw: RawWorkflowV1, map: YamlSourceMap): ConfigDiagnostic[] {
  const collector = createDiagnosticCollector();
  const add = (pointer: string) => collector.add({ code: "WORKFLOW_METADATA_LIMIT_EXCEEDED", severity: "error", message: "Workflow metadata exceeds its safety limit.", source, range: map[pointer]?.value ?? map[""]?.value ?? sourceRange(0, 1, 1, 0, 1, 1), resourceId: id });
  if (bytes(raw.name) > WORKFLOW_LIMITS.nameBytes) add("/name");
  if (bytes(raw.description) > WORKFLOW_LIMITS.descriptionBytes) add("/description");
  if (bytes(raw["use-when"]) > WORKFLOW_LIMITS.useWhenBytes) add("/use-when");
  if (bytes(raw["avoid-when"]) > WORKFLOW_LIMITS.avoidWhenBytes) add("/avoid-when");
  if ((raw.tags?.length ?? 0) > WORKFLOW_LIMITS.tags) add("/tags");
  if ((raw.examples?.length ?? 0) > WORKFLOW_LIMITS.examples) add("/examples");
  raw.examples?.forEach((value, index) => { if (bytes(value) > WORKFLOW_LIMITS.exampleBytes) add(`/examples/${index}`); });
  if ((raw["suggested-next"]?.length ?? 0) > WORKFLOW_LIMITS.suggestedNext) add("/suggested-next");
  if (bytes(raw.instructions.root) > WORKFLOW_LIMITS.instructionBytes) add("/instructions/root");
  if (bytes(raw.instructions.shared) > WORKFLOW_LIMITS.instructionBytes) add("/instructions/shared");
  if (bytes(raw.instructions.root) + bytes(raw.instructions.shared) > WORKFLOW_LIMITS.instructionCombinedBytes) add("/instructions");
  return collector.result().diagnostics;
}
function sameIdentity(before: WorkflowDescriptorStat, after: WorkflowDescriptorStat): boolean {
  return before.isFile() && after.isFile()
    && before.dev === after.dev
    && before.ino === after.ino
    && after.size <= WORKFLOW_LIMITS.fileBytes;
}
function boundedDescriptorRead(path: string, operations: WorkflowLoadOperations): { bytes?: Uint8Array; code?: ConfigDiagnosticCode } {
  const open = operations.open ?? ((value: string) => openSync(value, "r"));
  const fstat = operations.fstat ?? fstatSync;
  const read = operations.read ?? readSync;
  const close = operations.close ?? closeSync;
  let fd: number | undefined;
  try {
    fd = open(path);
    const before = fstat(fd);
    if (!before.isFile()) return { code: "RESOURCE_TYPE_MISMATCH" };
    if (before.size > WORKFLOW_LIMITS.fileBytes) return { code: "WORKFLOW_FILE_TOO_LARGE" };
    const buffer = new Uint8Array(WORKFLOW_LIMITS.fileBytes + 1);
    let used = 0;
    while (used < buffer.byteLength) {
      const count = read(fd, buffer, used, buffer.byteLength - used, null);
      if (!Number.isInteger(count) || count < 0 || count > buffer.byteLength - used) return { code: "WORKFLOW_READ_FAILED" };
      if (count === 0) break;
      used += count;
    }
    const after = fstat(fd);
    if (!sameIdentity(before, after)) return { code: after.size > WORKFLOW_LIMITS.fileBytes ? "WORKFLOW_FILE_TOO_LARGE" : "WORKFLOW_READ_FAILED" };
    if (used > WORKFLOW_LIMITS.fileBytes) return { code: "WORKFLOW_FILE_TOO_LARGE" };
    return { bytes: buffer.slice(0, used) };
  } catch {
    return { code: "WORKFLOW_READ_FAILED" };
  } finally {
    if (fd !== undefined) try { close(fd); } catch { /* read failure already reported */ }
  }
}
export function loadWorkflowResources(project: ConfiguredProject, operations: WorkflowLoadOperations = {}): WorkflowResource[] {
  const output: WorkflowResource[] = [];
  for (const entry of project.registries.workflows) {
    const source = entry.projectPath ?? `.pi/hive/workflows/${entry.id}.yaml`;
    if (entry.status === "failed" || !entry.canonicalPath) { output.push(fail(entry.id, source, entry.diagnosticCodes[0] ?? "WORKFLOW_READ_FAILED", "Workflow registry entry is unavailable.", entry.sourceRange)); continue; }
    const beforeTarget = resolveRegistryTarget(project.projectRoot, dirname(project.manifestPath), "workflows", entry.declaredPath);
    if (!beforeTarget.ok || beforeTarget.canonicalPath !== entry.canonicalPath) { output.push(fail(entry.id, source, "RESOURCE_PATH_ESCAPE", "Workflow target changed or escaped before read.", entry.sourceRange)); continue; }
    const readResult = boundedDescriptorRead(entry.canonicalPath, operations);
    if (!readResult.bytes) { output.push(fail(entry.id, source, readResult.code ?? "WORKFLOW_READ_FAILED", "Workflow resource cannot be read safely.")); continue; }
    const afterTarget = resolveRegistryTarget(project.projectRoot, dirname(project.manifestPath), "workflows", entry.declaredPath);
    if (!afterTarget.ok || afterTarget.canonicalPath !== entry.canonicalPath) { output.push(fail(entry.id, source, "RESOURCE_PATH_ESCAPE", "Workflow target changed or escaped during read.", entry.sourceRange)); continue; }
    let rawSource: string;
    try { rawSource = new TextDecoder("utf-8", { fatal: true }).decode(readResult.bytes); }
    catch { output.push(fail(entry.id, source, "CATALOG_TEXT_INVALID_UTF8", "Workflow source is not valid UTF-8.")); continue; }
    const parsed = parseConfigYaml(rawSource, source);
    if (!parsed.value) { output.push({ status: "failed", id: entry.id, source, diagnostics: parsed.diagnostics }); continue; }
    const validated = validateSchemaValue(WorkflowV1Schema, parsed.value.data, source, parsed.value.sourceMap);
    if (!validated.value) { output.push({ status: "failed", id: entry.id, source, diagnostics: validated.diagnostics }); continue; }
    const metadata = metadataDiagnostics(entry.id, source, validated.value, parsed.value.sourceMap);
    if (metadata.length) { output.push({ status: "failed", id: entry.id, source, diagnostics: metadata }); continue; }
    output.push({ status: "loaded", id: entry.id, source, rawSource, sourceMap: parsed.value.sourceMap, value: validated.value });
  }
  return output;
}
