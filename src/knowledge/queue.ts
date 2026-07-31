import { randomUUID } from "node:crypto";
import type { JsonValue } from "../config/types";
import { createWorkflowEvent } from "../workflows/events";
import { appendWorkflowEventChecked, readWorkflowJournal } from "../workflows/journal";
import {
  CURATOR_EXECUTION_POLICY,
  restoreKnowledgeEnrichmentState,
  type DurableKnowledgeJob,
  type KnowledgeEnrichmentState,
  type KnowledgeJobState,
} from "./enrichment";

export interface DurableKnowledgeQueueOptions {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly ownerNonce?: string;
  readonly hasOwnership?: () => boolean;
  readonly isIdle: () => boolean;
  readonly process: (job: DurableKnowledgeJob, signal: AbortSignal) => void | Promise<void>;
  readonly verifyOwnerDead?: (ownerNonce: string) => boolean | Promise<boolean>;
  readonly disposeActive?: (jobId: string) => void | Promise<void>;
  readonly preemptSettleMs?: number;
  readonly disposeSettleMs?: number;
  readonly now?: () => string;
}

type PreemptionReason = "user-work" | "shutdown" | "curator-timeout";
class QueuePreemption extends Error {
  readonly queueReason: PreemptionReason;
  constructor(reason: PreemptionReason) { super(`Knowledge curation preempted: ${reason}`); this.name = "QueuePreemption"; this.queueReason = reason; }
}
function compare(left: DurableKnowledgeJob, right: DurableKnowledgeJob): number {
  return left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : left.jobId < right.jobId ? -1 : left.jobId > right.jobId ? 1 : 0;
}
function message(error: unknown): string {
  const value = String(error instanceof Error ? error.message : error).normalize("NFC");
  if (Buffer.byteLength(value, "utf8") <= 2_048) return value;
  return Buffer.from(value, "utf8").subarray(0, 2_048).toString("utf8").replace(/\ufffd$/u, "");
}
async function settleWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

export class DurableKnowledgeQueue {
  readonly options: DurableKnowledgeQueueOptions;
  readonly ownerNonce: string;
  private draining?: Promise<void>;
  private active?: Readonly<{ jobId: string; token: symbol; controller: AbortController }>;
  private closed = false;

  constructor(options: DurableKnowledgeQueueOptions) {
    this.options = options;
    this.ownerNonce = options.ownerNonce ?? randomUUID();
  }

  restore(): KnowledgeEnrichmentState {
    return restoreKnowledgeEnrichmentState(readWorkflowJournal(this.options.projectRoot, this.options.sessionId));
  }

  private transition(jobId: string, from: KnowledgeJobState, to: KnowledgeJobState, attemptCount: number, staleReevaluations: number, reason: string): DurableKnowledgeJob {
    let published: DurableKnowledgeJob | undefined;
    const before = this.restore().jobs[jobId];
    appendWorkflowEventChecked(this.options.projectRoot, createWorkflowEvent({
      projectId: this.options.projectId, sessionId: this.options.sessionId, runId: before?.runId,
      type: "knowledge.transition", producer: "harness", correlationId: `knowledge-job-${jobId}`,
      payload: { formatVersion: 1, operation: "job-transition", jobId, from, to, attemptCount, staleReevaluations, reason, ownerNonce: this.ownerNonce } as JsonValue,
      timestamp: this.options.now?.(),
    }), (events) => {
      const current = restoreKnowledgeEnrichmentState(events).jobs[jobId];
      if (!current || current.projectId !== this.options.projectId || current.sessionId !== this.options.sessionId || current.state !== from
        || current.attemptCount > attemptCount || current.staleReevaluations > staleReevaluations
        || (from === "active" && current.activeOwnerNonce !== this.ownerNonce)) throw new Error("Knowledge queue transition lost its exact durable owner CAS");
      published = Object.freeze({ ...current, state: to, attemptCount, staleReevaluations, updatedAt: this.options.now?.() ?? new Date().toISOString(),
        ...(to === "active" ? { activeOwnerNonce: this.ownerNonce } : { activeOwnerNonce: undefined }), lastReason: reason });
    });
    return published!;
  }

  private async takeOver(job: DurableKnowledgeJob): Promise<DurableKnowledgeJob | undefined> {
    if (job.state !== "active" || !job.activeOwnerNonce || job.activeOwnerNonce === this.ownerNonce) return undefined;
    if (!this.options.verifyOwnerDead || !await this.options.verifyOwnerDead(job.activeOwnerNonce)) return undefined;
    try {
      appendWorkflowEventChecked(this.options.projectRoot, createWorkflowEvent({
        projectId: this.options.projectId, sessionId: this.options.sessionId, runId: job.runId,
        type: "knowledge.transition", producer: "recovery", correlationId: `knowledge-takeover-${job.jobId}`,
        payload: { formatVersion: 1, operation: "job-owner-taken-over", jobId: job.jobId, expectedOwnerNonce: job.activeOwnerNonce, newOwnerNonce: this.ownerNonce, reason: "verified process/boot owner death" },
        timestamp: this.options.now?.(),
      }), (events) => {
        const current = restoreKnowledgeEnrichmentState(events).jobs[job.jobId];
        if (!current || current.state !== "active" || current.activeOwnerNonce !== job.activeOwnerNonce) throw new Error("Knowledge queue takeover lost its exact durable owner CAS");
      });
    } catch (error) {
      const raced = this.restore().jobs[job.jobId];
      if (raced?.state === "active" || raced?.activeOwnerNonce) throw error;
    }
    const recovered = this.restore().jobs[job.jobId];
    return recovered?.state === "paused" ? recovered : undefined;
  }

  private next(): DurableKnowledgeJob | undefined {
    const values = Object.values(this.restore().jobs).sort(compare);
    return values.find((job) => job.state === "active") ?? values.find((job) => job.state === "queued" || job.state === "paused");
  }

  private async runOne(initial: DurableKnowledgeJob): Promise<void> {
    if (this.options.hasOwnership && !this.options.hasOwnership()) return;
    let job = initial;
    if (job.state === "active") {
      const recovered = await this.takeOver(job);
      if (!recovered) return;
      job = recovered;
    }
    try {
      job = this.transition(job.jobId, job.state, "active", job.attemptCount + 1, job.staleReevaluations, "idle-start");
    } catch {
      return;
    }
    const controller = new AbortController();
    const token = Symbol(job.jobId);
    this.active = Object.freeze({ jobId: job.jobId, token, controller });
    const timer = setTimeout(() => controller.abort(new QueuePreemption("curator-timeout")), CURATOR_EXECUTION_POLICY.timeoutMs);
    timer.unref?.();
    try {
      await this.options.process(job, controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason;
      const restored = this.restore();
      const current = restored.jobs[job.jobId];
      if (!current || current.state !== "active" || current.activeOwnerNonce !== this.ownerNonce) return;
      if (!restored.curatorPlanEffectsComplete[job.jobId]) throw new Error("Curator processor returned without exact durable plan-effect closure");
      this.transition(job.jobId, "active", "completed", current.attemptCount, current.staleReevaluations, "curation-completed");
    } catch (error) {
      const current = this.restore().jobs[job.jobId];
      if (!current || current.state !== "active" || current.activeOwnerNonce !== this.ownerNonce) return;
      const preemption = error instanceof QueuePreemption ? error.queueReason
        : controller.signal.aborted && controller.signal.reason instanceof QueuePreemption ? controller.signal.reason.queueReason
          : undefined;
      const latest = this.restore();
      const denial = latest.curatorBudgetDenials[job.jobId];
      const exhausted = !preemption && denial !== undefined;
      this.transition(job.jobId, "active", exhausted ? "failed" : "paused", current.attemptCount, current.staleReevaluations, exhausted ? denial.reason : preemption ?? message(error));
    } finally {
      clearTimeout(timer);
      if (this.active?.token === token) this.active = undefined;
    }
  }

  private async drain(): Promise<void> {
    while (!this.closed && this.options.isIdle()) {
      const job = this.next();
      if (!job) return;
      const before = `${job.state}:${job.attemptCount}:${job.activeOwnerNonce ?? ""}`;
      await this.runOne(job);
      const settled = this.restore().jobs[job.jobId];
      if (!settled || settled.state === "paused" || settled.state === "active") return;
      if (`${settled.state}:${settled.attemptCount}:${settled.activeOwnerNonce ?? ""}` === before) return;
    }
  }

  wake(): Promise<void> {
    if (this.closed || !this.options.isIdle() || (this.options.hasOwnership && !this.options.hasOwnership())) return Promise.resolve();
    if (this.draining) return this.draining;
    const work = this.drain();
    this.draining = work;
    void work.finally(() => { if (this.draining === work) this.draining = undefined; }).catch(() => undefined);
    return work;
  }

  private async preempt(reason: PreemptionReason): Promise<void> {
    const active = this.active;
    if (!active) return;
    if (!active.controller.signal.aborted) active.controller.abort(new QueuePreemption(reason));
    const work = this.draining;
    if (work && await settleWithin(work, this.options.preemptSettleMs ?? CURATOR_EXECUTION_POLICY.preemptSettleMs)) return;
    const disposal = Promise.resolve().then(() => this.options.disposeActive?.(active.jobId));
    await settleWithin(disposal, this.options.disposeSettleMs ?? CURATOR_EXECUTION_POLICY.disposeSettleMs);
    void work?.catch(() => undefined);
  }

  preemptForUserWork(): Promise<void> { return this.preempt("user-work"); }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.preempt("shutdown");
  }

  hasLiveWork(): boolean { return Boolean(this.active || this.draining); }
}
