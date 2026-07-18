import { randomUUID } from "node:crypto";
import { acquireRuntimeOwnership, heartbeatRuntimeOwnership, releaseRuntimeOwnership, type AcquireOwnershipOptions } from "./ownership";
import { appendWorkflowEvent } from "./journal";
import { createWorkflowEvent } from "./events";
import { commitWorkflowSelection, listSessionLinks, type NormalSessionLink, type WorkflowSessionLink } from "./sessions";

export interface SelectableWorkflow { readonly workflowId: string; readonly activationHash: string; readonly source: "current" | "stale" | "missing" | "invalid"; readonly resumable: boolean; readonly freshEnabled: boolean; readonly model: string; readonly thinking: string; readonly tools: readonly string[] }
export interface SessionNavigationAdapter { create(input: { parentSession: string; name: string; workflowId: string; activationHash: string }): Promise<{ piSessionId: string; piSessionFile: string }>; switch(input: { piSessionFile: string; withSession: (ctx: unknown) => Promise<void> | void }): Promise<{ cancelled: boolean }> }
export interface SelectionInput { projectRoot: string; projectId: string; currentPiSessionId: string; workflow: SelectableWorkflow; fresh?: boolean; adapter: SessionNavigationAdapter; owner: AcquireOwnershipOptions & { nonce: string } }
export type SelectionResult = Readonly<{ kind: "created" | "resumed"; link: WorkflowSessionLink }>;
function normalLink(root: string): NormalSessionLink { const normal = listSessionLinks(root).find((entry): entry is NormalSessionLink => entry.kind === "normal"); if (!normal) throw new Error("Canonical normal parent is missing"); return normal; }
function own(root: string, id: string, owner: SelectionInput["owner"]): "existing" | "acquired" {
  try { if (heartbeatRuntimeOwnership(root, id, owner.nonce)) return "existing"; }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const result = acquireRuntimeOwnership(root, id, owner);
  if (!result.ok) throw new Error(`Runtime ownership rejected: ${result.reason}`);
  return "acquired";
}
function event(root: string, projectId: string, sessionId: string, type: "session.created" | "session.linked" | "session.selected", payload: Record<string, string | boolean>): void { appendWorkflowEvent(root, createWorkflowEvent({ projectId, sessionId, type, payload, producer: "runtime" })); }
export async function selectWorkflowSession(input: SelectionInput): Promise<SelectionResult> {
  const normal = normalLink(input.projectRoot); const links = listSessionLinks(input.projectRoot); const current = links.find((entry): entry is WorkflowSessionLink => entry.kind === "workflow" && entry.workflowId === input.workflow.workflowId && entry.status === "current");
  if (!input.fresh && current) {
    if (!input.workflow.resumable || current.activationHash !== input.workflow.activationHash) throw new Error("Workflow activation is not resumable or compatible");
    const ownership = own(input.projectRoot, current.workflowSessionId, input.owner);
    const result = await input.adapter.switch({ piSessionFile: current.piSessionFile, withSession: async () => {} });
    if (result.cancelled) { if (ownership === "acquired") releaseRuntimeOwnership(input.projectRoot, current.workflowSessionId, input.owner.nonce); throw new Error("Session switch cancelled"); }
    event(input.projectRoot, input.projectId, current.workflowSessionId, "session.selected", { resumed: true }); return Object.freeze({ kind: "resumed", link: current });
  }
  if (input.workflow.source !== "current" || !input.workflow.freshEnabled) throw new Error("Fresh selection blocked by invalid or stale source");
  const previousOwnership = current ? own(input.projectRoot, current.workflowSessionId, input.owner) : undefined;
  const workflowSessionId = `workflow-${randomUUID()}`; own(input.projectRoot, workflowSessionId, input.owner); let created: { piSessionId: string; piSessionFile: string };
  try { created = await input.adapter.create({ parentSession: normal.piSessionFile, name: `hive:${input.workflow.workflowId}:${input.workflow.activationHash.slice(0, 8)}`, workflowId: input.workflow.workflowId, activationHash: input.workflow.activationHash }); }
  catch (error) { releaseRuntimeOwnership(input.projectRoot, workflowSessionId, input.owner.nonce); if (current && previousOwnership === "acquired") releaseRuntimeOwnership(input.projectRoot, current.workflowSessionId, input.owner.nonce); throw error; }
  const now = new Date().toISOString(); const link: WorkflowSessionLink = Object.freeze({ kind: "workflow", formatVersion: 1, workflowSessionId, workflowId: input.workflow.workflowId, activationHash: input.workflow.activationHash, piSessionId: created.piSessionId, piSessionFile: created.piSessionFile, normalParentId: normal.piSessionId, normalParentFile: normal.piSessionFile, status: "current", stale: false, model: input.workflow.model, thinking: input.workflow.thinking, tools: [...new Set(input.workflow.tools)].sort(), createdAt: now, updatedAt: now, name: `hive:${input.workflow.workflowId}:${input.workflow.activationHash.slice(0, 8)}` });
  const archived = current ? Object.freeze({ ...current, status: "archived" as const, name: `${current.name}:archived:${current.activationHash.slice(0, 8)}`, updatedAt: now }) : undefined;
  try { commitWorkflowSelection(input.projectRoot, input.workflow.workflowId, current?.workflowSessionId, archived, link); }
  catch (error) { releaseRuntimeOwnership(input.projectRoot, workflowSessionId, input.owner.nonce); if (current && previousOwnership === "acquired") releaseRuntimeOwnership(input.projectRoot, current.workflowSessionId, input.owner.nonce); throw error; }
  if (current && !releaseRuntimeOwnership(input.projectRoot, current.workflowSessionId, input.owner.nonce)) throw new Error("Previous runtime ownership could not be released");
  event(input.projectRoot, input.projectId, workflowSessionId, "session.created", { workflowId: input.workflow.workflowId }); event(input.projectRoot, input.projectId, workflowSessionId, "session.linked", { normalParentId: normal.piSessionId }); return Object.freeze({ kind: "created", link });
}
export async function exitWorkflowSession(input: { projectRoot: string; currentPiSessionId: string; ownerNonce: string; adapter: SessionNavigationAdapter }): Promise<{ piSessionId: string; activeTools: readonly string[] }> {
  const links = listSessionLinks(input.projectRoot); const current = links.find((entry): entry is WorkflowSessionLink => entry.kind === "workflow" && entry.piSessionId === input.currentPiSessionId); const normal = normalLink(input.projectRoot);
  if (current && !heartbeatRuntimeOwnership(input.projectRoot, current.workflowSessionId, input.ownerNonce)) throw new Error("Runtime ownership does not match exit request");
  const result = await input.adapter.switch({ piSessionFile: normal.piSessionFile, withSession: async () => {} }); if (result.cancelled) throw new Error("Session switch cancelled");
  if (current && !releaseRuntimeOwnership(input.projectRoot, current.workflowSessionId, input.ownerNonce)) throw new Error("Runtime ownership release failed");
  return Object.freeze({ piSessionId: normal.piSessionId, activeTools: normal.normalTools });
}
