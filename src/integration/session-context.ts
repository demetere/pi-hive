import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface SessionContextUse {
  replaced: boolean;
  replacementSessionId?: string;
  replacementContext?: ExtensionContext;
}

const activeUses = new WeakMap<ExtensionCommandContext, SessionContextUse>();
const REPLACEMENT_USES_KEY = Symbol.for("pi-hive.session-replacement-uses.v1");
type ProcessSessionContextState = typeof globalThis & { [REPLACEMENT_USES_KEY]?: Map<string, SessionContextUse> };
const processSessionContextState = globalThis as ProcessSessionContextState;
const replacementUses = processSessionContextState[REPLACEMENT_USES_KEY] ??= new Map<string, SessionContextUse>();

/** Track one command invocation without reading from its potentially stale context. */
export function trackSessionContext(ctx: ExtensionCommandContext): Readonly<{
  wasReplaced(): boolean;
  replacementContext(): ExtensionContext | undefined;
  close(): void;
}> {
  const use: SessionContextUse = { replaced: false };
  activeUses.set(ctx, use);
  return Object.freeze({
    wasReplaced: () => use.replaced,
    replacementContext: () => use.replacementContext,
    close: () => {
      if (use.replacementSessionId && replacementUses.get(use.replacementSessionId) === use) replacementUses.delete(use.replacementSessionId);
      if (activeUses.get(ctx) === use) activeUses.delete(ctx);
    },
  });
}

/** Called once native replacement is observed; it never dereferences the old context. */
export function markSessionContextReplaced(ctx: ExtensionCommandContext): void {
  const use = activeUses.get(ctx);
  if (use) use.replaced = true;
}

/** Bind result delivery only after Pi supplies the fresh protected context. */
export function bindFreshSessionContext(ctx: ExtensionCommandContext, fresh: ExtensionContext): void {
  const use = activeUses.get(ctx);
  if (!use) return;
  use.replaced = true;
  use.replacementSessionId = fresh.sessionManager.getSessionId();
  use.replacementContext = fresh;
  replacementUses.set(use.replacementSessionId, use);
}

/** Safe identity-only queries: neither dereferences the potentially stale context. */
export function sessionContextWasReplaced(ctx: ExtensionCommandContext): boolean {
  return activeUses.get(ctx)?.replaced === true;
}

export function replacementSessionContext(ctx: ExtensionCommandContext): ExtensionContext | undefined {
  return activeUses.get(ctx)?.replacementContext;
}

/** Bind the tracked command to the durable identity before native replacement. */
export function bindSessionReplacement(ctx: ExtensionCommandContext, piSessionId: string): void {
  const use = activeUses.get(ctx);
  if (!use) return;
  if (use.replacementSessionId && replacementUses.get(use.replacementSessionId) === use) replacementUses.delete(use.replacementSessionId);
  use.replacementSessionId = piSessionId;
  replacementUses.set(piSessionId, use);
}

/** Publish the replacement session_start context for bounded command-result feedback. */
export function publishSessionContext(ctx: ExtensionContext): void {
  const use = replacementUses.get(ctx.sessionManager.getSessionId());
  if (use) use.replacementContext = ctx;
}
