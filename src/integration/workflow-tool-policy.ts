import type { ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { ActivationSnapshotFileV1 } from "../config/snapshot";
import { compileSnapshotNodeToolPolicies, type SnapshotNodeToolPolicy } from "../capabilities/runtime-policy";
import { utf8Prefix } from "../workflows/values";

export interface SelectedWorkflowToolAuthority {
  readonly snapshot: ActivationSnapshotFileV1;
  readonly nodeId: string;
  readonly policy?: SnapshotNodeToolPolicy;
}

const BUILTIN_ALIASES = Object.freeze({ edit: "write", grep: "read", find: "read", ls: "read" } as const);

function boundedReason(reason: string): string {
  return Buffer.byteLength(reason, "utf8") <= 2_048 ? reason : utf8Prefix(reason, 2_048);
}

/**
 * Mandatory schema-v1 interception for Pi built-ins and custom tools. The
 * immutable snapshot is the allowlist; unknown names and unlisted mutation
 * aliases fail closed before Pi executes them.
 */
export function createSelectedWorkflowToolPolicyHook(
  projectRoot: string,
  resolve: () => SelectedWorkflowToolAuthority | undefined,
): (event: ToolCallEvent) => Promise<ToolCallEventResult | undefined> {
  const compiled = new WeakMap<object, ReadonlyMap<string, SnapshotNodeToolPolicy>>();
  const policies = (snapshot: ActivationSnapshotFileV1): ReadonlyMap<string, SnapshotNodeToolPolicy> => {
    const existing = compiled.get(snapshot as object);
    if (existing) return existing;
    const created = new Map(compileSnapshotNodeToolPolicies({ projectRoot, snapshot }).map((policy) => [policy.nodeId, policy]));
    compiled.set(snapshot as object, created);
    return created;
  };

  return async (event) => {
    const selected = resolve();
    if (!selected) return undefined;
    const policy = selected.policy ?? policies(selected.snapshot).get(selected.nodeId);
    if (!policy) return { block: true, reason: "Workflow tool call denied: selected node authority is missing" };
    const name = typeof event.toolName === "string" ? event.toolName : "";
    const authority = selected.snapshot.payload.authority.nodes.find((node) => node.nodeId === selected.nodeId);
    if (!authority) return { block: true, reason: "Workflow tool call denied: selected snapshot node is missing" };
    const allowed = new Set(Array.isArray(authority.tools) ? authority.tools : []);
    const alias = BUILTIN_ALIASES[name as keyof typeof BUILTIN_ALIASES];
    if (!allowed.has(name) && (!alias || !allowed.has(alias))) {
      return { block: true, reason: boundedReason(`Workflow tool call denied for ${selected.nodeId}: ${name || "unknown"} is outside immutable snapshot authority`) };
    }
    if (["read", "write", "edit", "grep", "find", "ls", "bash"].includes(name)) {
      const denied = await policy.hook(event);
      if (denied) return { block: true, reason: boundedReason(denied.reason) };
    }
    return undefined;
  };
}
