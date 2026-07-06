import { randomUUID } from "node:crypto";
import { handleReviewSurface, registerReviewSurface, renderReviewInput, type ReviewContext, type ReviewInput, type ReviewSurface } from "../../engine/review";
import { parseRid } from "../../engine/review";
import * as openspec from "../../engine/openspec";
import { insertPlanVerdict, listVerdicts } from "./db";
import { enqueueDashboardAction, resolveProjectCwd } from "./plan-bridge";

// Bun-side wiring for the self-hosted Plannotator plan-review surface. Builds the
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
  const sidecarVerdict = openspec.agentReviewVerdict(ctx.cwd, ctx.change, ctx.artifact);
  if (sidecarVerdict) return sidecarVerdict;

  // If any structured per-artifact review state exists, absence for THIS
  // artifact is meaningful: do not fall back to a change-level SQLite verdict
  // from another artifact. That mismatch is what made proposal approval look
  // available and then reject in the live session.
  if (Object.keys(openspec.readAgentReviewLedger(ctx.cwd, ctx.change)).length > 0) return null;

  // Older reviewer flows may have only persisted a change-level SQLite verdict.
  // Use it only for fully legacy changes with no sidecar agent-review state.
  const verdict = listVerdicts(ctx.change, ctx.cwd).find((v) => v.reviewer !== "ui")?.verdict;
  return verdict === "green" || verdict === "yellow" || verdict === "red" ? verdict : null;
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
    onApprove(ctx, input) {
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
        enqueueDashboardAction(ctx.cwd, {
          type: "plan_review_not_ready",
          changeId: ctx.change,
          artifact: ctx.artifact,
          feedback: gateFeedback,
        });
        return;
      }
      recordVerdict(ctx, "green", feedback);
      // Record the human's per-artifact approval in the ledger. This both
      // advances the planning gate (the next artifact becomes authorable) and,
      // for tasks, opens the execution gate.
      openspec.setArtifactApproval(ctx.cwd, ctx.change, ctx.artifact, "green");
      // Unblock the live session: the artifact's gate is satisfied; the planner
      // proceeds to the next authorable artifact (or /hive-execute once tasks
      // pass validation).
      const tasks = openspec.isArtifactApproved(ctx.cwd, ctx.change, "tasks");
      enqueueDashboardAction(ctx.cwd, {
        type: "plan_review_approved",
        changeId: ctx.change,
        artifact: ctx.artifact,
        nextArtifact: openspec.nextAuthorableArtifact(ctx.cwd, ctx.change),
        readyToExecute: tasks && openspec.isReadyToExecute(ctx.cwd, ctx.change),
        feedback: feedback || undefined,
      });
    },
    onDeny(ctx, input) {
      // Structured feedback: the top-level note PLUS each inline annotation
      // ("on <quote>: <comment>") so the planner gets anchored, per-location
      // guidance instead of a single blob.
      const feedback = renderReviewInput(input);
      recordVerdict(ctx, "red", feedback);
      // Record the human's per-artifact denial. This revokes the artifact's
      // approval AND (in the ledger) every downstream artifact's approval, since
      // work built on a rejected upstream artifact can no longer be trusted.
      openspec.setArtifactApproval(ctx.cwd, ctx.change, ctx.artifact, "red");
      // Route the structured feedback back to the planning agent.
      enqueueDashboardAction(ctx.cwd, {
        type: "plan_review_denied",
        changeId: ctx.change,
        artifact: ctx.artifact,
        feedback: feedback || "Artifact rejected by reviewer.",
        annotationCount: input.annotations.length,
      });
    },
  },
});

// Whether the plan-review surface is available (vendored HTML present).
export function planReviewAvailable(): boolean {
  return surface !== null;
}

// Dispatch a request to the plan-review surface. Returns null if the path is not
// part of the surface (server continues its own routing). Applies no token check
// — the surface enforces same-origin at the caller; see review.ts.
export async function handlePlanReview(req: Request, url: URL): Promise<Response | null> {
  if (!surface) return null;
  return handleReviewSurface(surface, req, url);
}
