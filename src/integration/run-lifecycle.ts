import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PauseCoordinator, ResumeCoordinator, WorkflowRunLifecycle } from "../workflows/runs";

export const RUN_INPUT_MESSAGE_TYPE = "pi-hive-run-input-v1";

export interface WorkflowRunHookRuntime {
  readonly lifecycle: WorkflowRunLifecycle;
  pause(reason: string): Promise<boolean>;
  resume(): Promise<boolean>;
}

export interface WorkflowRunHookOptions {
  /** Resolve on every callback so linked-session replacement cannot retain stale authority. */
  readonly resolveLifecycle: () => WorkflowRunLifecycle | undefined;
  /** Production orchestration boundary; tests and pure consumers may use the coordinators below. */
  readonly resolveRuntime?: () => WorkflowRunHookRuntime | undefined;
  readonly nextInputId?: (event: object) => string;
  readonly pauseCoordinator: PauseCoordinator;
  readonly resumeCoordinator: ResumeCoordinator;
}

interface PreparedRequest {
  readonly lifecycle: WorkflowRunLifecycle;
  readonly requestId: string;
}

/**
 * Bind the schema-v1 lifecycle service to Pi hooks without activating the
 * legacy runtime. W27 owns registration of this bridge in the package entrypoint.
 */
export function registerWorkflowRunHooks(pi: ExtensionAPI, options: WorkflowRunHookOptions): void {
  const callbackIds = new WeakMap<object, string>();
  const preparedBySession = new Map<string, PreparedRequest>();
  const resumeAttempts = new WeakMap<WorkflowRunLifecycle, Promise<void>>();
  let inFlight: PreparedRequest | undefined;
  const inputId = (event: object): string => {
    const existing = callbackIds.get(event);
    if (existing) return existing;
    const created = options.nextInputId?.(event) ?? `input-callback-${randomUUID()}`;
    callbackIds.set(event, created);
    return created;
  };

  const resumeCurrentLifecycle = async (): Promise<WorkflowRunLifecycle | undefined> => {
    while (true) {
      const runtime = options.resolveRuntime?.();
      const lifecycle = runtime?.lifecycle ?? options.resolveLifecycle();
      if (!lifecycle) return undefined;
      const run = lifecycle.restore().latestRun;
      if (run?.status === "paused") {
        let attempt = resumeAttempts.get(lifecycle);
        if (!attempt) {
          attempt = (async () => {
            let paused = lifecycle.restore().latestRun;
            if (paused?.status === "paused" && paused.pauseReleasePending === true) {
              await lifecycle.pause("complete paused authority release before session resume", options.pauseCoordinator);
              paused = lifecycle.restore().latestRun;
            }
            if (paused?.status === "paused") {
              if (runtime) await runtime.resume();
              else await lifecycle.resume(options.resumeCoordinator);
            }
          })();
          resumeAttempts.set(lifecycle, attempt);
          void attempt.finally(() => {
            if (resumeAttempts.get(lifecycle) === attempt) resumeAttempts.delete(lifecycle);
          }).catch(() => undefined);
        }
        try { await attempt; }
        catch (error) {
          throw new Error(`Workflow session resume blocked: ${String(error instanceof Error ? error.message : error)}`, { cause: error });
        }
      }
      if (options.resolveLifecycle() === lifecycle) return lifecycle;
    }
  };

  pi.on("session_start", async () => {
    await resumeCurrentLifecycle();
  });

  pi.on("input", async (event) => {
    if (!options.resolveLifecycle() || event.text.trimStart().startsWith("/")) return { action: "continue" as const };
    const lifecycle = await resumeCurrentLifecycle();
    if (!lifecycle) return { action: "continue" as const };
    lifecycle.recordUserInput({ inputId: inputId(event), text: event.text, source: event.source });
    return { action: "continue" as const };
  });

  pi.on("context", async (event) => {
    const lifecycle = await resumeCurrentLifecycle();
    if (!lifecycle) return;
    const pending = lifecycle.pendingInputs();
    if (!pending.length) return;
    const sessionId = lifecycle.options.sessionId;
    const recovered = lifecycle.preparedInputDelivery();
    const requestId = recovered?.requestId ?? `root-request-${randomUUID()}`;
    const prepared = recovered ?? lifecycle.prepareInputDelivery(requestId);
    preparedBySession.set(sessionId, { lifecycle, requestId: prepared.requestId });
    const steering = prepared.inputs.filter((input) => input.kind === "steering");
    if (!steering.length) return;
    const content = [
      "The following sequenced user input arrived while this run was active. Treat every item as steering for the current run:",
      ...steering.map((input) => `[input ${input.sequence}] ${input.text}`),
    ].join("\n");
    return {
      messages: [...event.messages, {
        role: "custom" as const,
        customType: RUN_INPUT_MESSAGE_TYPE,
        content,
        display: false,
        details: { runId: prepared.runId, throughSequence: steering.at(-1)!.sequence, requestId: prepared.requestId },
        timestamp: Date.now(),
      }],
    };
  });

  pi.on("before_provider_request", async () => {
    const lifecycle = await resumeCurrentLifecycle();
    if (!lifecycle) return;
    inFlight = preparedBySession.get(lifecycle.options.sessionId);
  });

  pi.on("after_provider_response", async (event) => {
    const accepted = Number.isInteger(event.status) && event.status >= 200 && event.status < 300;
    const request = inFlight;
    inFlight = undefined;
    if (!request || !accepted) return;
    request.lifecycle.confirmInputDelivery(request.requestId);
    preparedBySession.delete(request.lifecycle.options.sessionId);
  });

  pi.on("session_before_switch", async (event) => {
    const runtime = options.resolveRuntime?.();
    const lifecycle = runtime?.lifecycle ?? options.resolveLifecycle();
    if (!lifecycle) return;
    try {
      if (runtime) await runtime.pause(`native ${event.reason}`);
      else await lifecycle.pause(`native ${event.reason}`, options.pauseCoordinator);
      return { cancel: false };
    } catch {
      return { cancel: true };
    }
  });
  pi.on("session_before_fork", async () => options.resolveLifecycle() ? { cancel: true } : undefined);
  pi.on("session_before_tree", async () => options.resolveLifecycle() ? { cancel: true } : undefined);
  pi.on("session_shutdown", async () => {
    const runtime = options.resolveRuntime?.();
    const lifecycle = runtime?.lifecycle ?? options.resolveLifecycle();
    if (!lifecycle) return;
    if (runtime) await runtime.pause("process shutdown");
    else await lifecycle.pause("process shutdown", options.pauseCoordinator);
  });
}
