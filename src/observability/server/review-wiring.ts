import { randomUUID } from "node:crypto";
import { handleReviewSurface, isAuthorizedReviewMutation, registerReviewSurface, renderReviewInput, type ReviewContext, type ReviewSurface } from "../../engine/review";
import { parseRid } from "../../engine/review";
import * as openspec from "../../engine/openspec";
import { insertPlanVerdict } from "./db";
import { enqueueDashboardAction, resolveProjectCwd } from "./plan-bridge";

// Bun-side wiring for the self-hosted review-only surface. Builds the
// ReviewHooks with SQLite verdict persistence + the dashboard-actions bridge, and
// exposes a single dispatcher the server calls early in its fetch handler.
//
// pi-hive OWNS the approval gate: approve/deny record a verdict in plan_verdicts
// (keyed on the OpenSpec change name, reviewer "ui") and round-trip to the live
// session via dashboard-actions. There is no OpenSpec mutation — OpenSpec is the
// store + validator; approval is pi-hive state.

const PLAN_REVIEW_MOUNT = "/pl-review/";

function recordVerdict(ctx: ReviewContext, verdict: "green" | "red", feedback: string): void {
  insertPlanVerdict({
    id: randomUUID(),
    changeId: ctx.change,
    reviewer: "ui",
    verdict,
    summary: feedback ? feedback.slice(0, 2000) : undefined,
    cwd: ctx.cwd,
    createdAt: new Date().toISOString(),
  });
}

function latestAgentVerdict(ctx: ReviewContext): openspec.AgentReviewVerdict {
  // Only a current, content-bound automated-review record can make an artifact
  // eligible for human approval. SQLite rows and project sidecars are display
  // history, not authority, and deliberately receive no migration fallback.
  return openspec.agentReviewVerdict(ctx.cwd, ctx.change, ctx.artifact);
}

const surface: ReviewSurface | null = registerReviewSurface({
  mountPath: PLAN_REVIEW_MOUNT,
  hooks: {
    resolveContext(rid, cwdParam) {
      const parsed = parseRid(rid);
      if (!parsed) return null;
      const cwd = resolveProjectCwd(cwdParam);
      if (!cwd || !openspec.changeExists(cwd, parsed.change)) return null;
      return { cwd, change: parsed.change, artifact: parsed.artifact };
    },
    async onApprove(ctx, input, expectedArtifactHash, signal) {
      const feedback = renderReviewInput(input);
      const agentVerdict = latestAgentVerdict(ctx);
      if (agentVerdict !== "green" && agentVerdict !== "yellow") {
        const gateFeedback = agentVerdict === "red"
          ? "Automated plan reviewer marked this artifact RED. Revise it before human approval."
          : "Automated plan reviewer has not marked this artifact ready for human approval yet.";
        // This is NOT a human rejection of the artifact; it is an invalid/early
        // approve attempt. Do not persist a red UI verdict and do not route it as
        // planner revision feedback, or the live session falsely says the human
        // rejected the plan.
        return { ok: false as const, error: gateFeedback };
      }
      // Validate asynchronously before persistence when this approval could open
      // execution. The content-bound write below rechecks the artifact hash after
      // the await, closing the external-writer race.
      const approvingTasks = /(?:^|\/)tasks(?:\.md)?$/.test(ctx.artifact);
      const tasksAlreadyApproved = openspec.isArtifactApproved(ctx.cwd, ctx.change, "tasks");
      const validation = approvingTasks || tasksAlreadyApproved
        ? await openspec.validateAsync(ctx.cwd, ctx.change, signal)
        : null;
      // Persist authority first. If the atomic write fails, the exception reaches
      // the request handler; no success verdict or unblock action is recorded.
      openspec.setArtifactApproval(ctx.cwd, ctx.change, ctx.artifact, "green", "dashboard-human", expectedArtifactHash);
      recordVerdict(ctx, "green", feedback);
      // Unblock the live session: the artifact's gate is satisfied; the planner
      // proceeds to the next authorable artifact (or /hive:execute once tasks
      // pass validation).
      const tasks = openspec.isArtifactApproved(ctx.cwd, ctx.change, "tasks");
      enqueueDashboardAction(ctx.cwd, {
        type: "plan_review_approved",
        changeId: ctx.change,
        artifact: ctx.artifact,
        nextArtifact: openspec.nextAuthorableArtifact(ctx.cwd, ctx.change),
        readyToExecute: tasks && !!validation && openspec.isReadyToExecuteWithValidation(ctx.cwd, ctx.change, validation),
        feedback: feedback || undefined,
      });
      return { ok: true as const };
    },
    onDeny(ctx, input, expectedArtifactHash) {
      // Structured feedback: the top-level note PLUS each inline annotation
      // ("on <quote>: <comment>") so the planner gets anchored, per-location
      // guidance instead of a single blob.
      const feedback = renderReviewInput(input);
      // Persist authority before display history or planner actions. A denial
      // removes downstream human records; write failures propagate fail-closed.
      openspec.setArtifactApproval(ctx.cwd, ctx.change, ctx.artifact, "red", "dashboard-human", expectedArtifactHash);
      recordVerdict(ctx, "red", feedback);
      // Route the structured feedback back to the planning agent.
      enqueueDashboardAction(ctx.cwd, {
        type: "plan_review_denied",
        changeId: ctx.change,
        artifact: ctx.artifact,
        feedback: feedback || "Artifact rejected by reviewer.",
        annotationCount: input.annotations.length,
      });
      return { ok: true as const };
    },
  },
});

// Whether the plan-review surface is available (vendored HTML present).
export function planReviewAvailable(): boolean {
  return surface !== null;
}

// Capability check used by the server's method gate before routing review
// mutations. Full freshness/body validation and nonce consumption happen in the
// handler itself.
export function isAuthorizedPlanReviewMutation(req: Request, url: URL): boolean {
  return surface ? isAuthorizedReviewMutation(surface, req, url) : false;
}

export async function handlePlanReview(req: Request, url: URL): Promise<Response | null> {
  if (!surface) return null;
  return handleReviewSurface(surface, req, url);
}
