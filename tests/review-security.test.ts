import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  handleReviewSurface,
  isAuthorizedReviewMutation,
  parseRid,
  registerReviewSurface,
  type ReviewHookResult,
  type ReviewInput,
  type ReviewSurface,
} from "../src/engine/review.ts";

const ORIGIN = "http://127.0.0.1:43191";
const STRICT_HEADERS = { host: "127.0.0.1:43191", origin: ORIGIN };

type Harness = {
  cwd: string;
  surface: ReviewSurface;
  approvals: ReviewInput[];
  denials: ReviewInput[];
};

function harness(options: {
  approve?: () => ReviewHookResult;
  deny?: () => ReviewHookResult;
  throwApprove?: boolean;
} = {}): Harness {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hive-review-security-"));
  const changeDir = join(cwd, "openspec", "changes", "add-auth");
  mkdirSync(changeDir, { recursive: true });
  writeFileSync(join(changeDir, "proposal.md"), "# proposal\n");
  const htmlPath = join(cwd, "review.html");
  writeFileSync(htmlPath, "<!doctype html><title>review</title>");
  const approvals: ReviewInput[] = [];
  const denials: ReviewInput[] = [];
  const surface = registerReviewSurface({
    mountPath: "/pl-review/",
    htmlPath,
    hooks: {
      resolveContext(rid, cwdParam) {
        const parsed = parseRid(rid);
        return parsed && cwdParam === cwd
          ? { cwd, change: parsed.change, artifact: parsed.artifact }
          : null;
      },
      onApprove(_ctx, input) {
        if (options.throwApprove) throw new Error("disk full");
        const result = options.approve?.() ?? { ok: true as const };
        if (result.ok) approvals.push(input);
        return result;
      },
      onDeny(_ctx, input) {
        const result = options.deny?.() ?? { ok: true as const };
        if (result.ok) denials.push(input);
        return result;
      },
    },
  });
  assert.ok(surface);
  return { cwd, surface: surface!, approvals, denials };
}

async function mint(h: Harness): Promise<{ response: Response; reviewUrl?: string }> {
  const req = new Request(`${ORIGIN}/review-sessions`, {
    method: "POST",
    headers: { ...STRICT_HEADERS, referer: `${ORIGIN}/`, "content-type": "application/json" },
    body: JSON.stringify({ rid: "add-auth#proposal.md", cwd: h.cwd }),
  });
  const response = (await handleReviewSurface(h.surface, req, new URL(req.url)))!;
  const body = await response.clone().json() as { reviewUrl?: string };
  return { response, reviewUrl: body.reviewUrl };
}

function decision(reviewUrl: string, path: "/api/approve" | "/api/deny" | "/api/feedback", body: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      ...STRICT_HEADERS,
      referer: `${ORIGIN}${reviewUrl}`,
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
}

async function handle(h: Harness, req: Request): Promise<Response | null> {
  return handleReviewSurface(h.surface, req, new URL(req.url));
}

test("review sessions require exact mutation metadata and are not cacheable", async () => {
  const h = harness();
  const headerless = new Request(`${ORIGIN}/review-sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rid: "add-auth#proposal.md", cwd: h.cwd }),
  });
  assert.equal((await handle(h, headerless))?.status, 403);

  const minted = await mint(h);
  assert.equal(minted.response.status, 201);
  assert.equal(minted.response.headers.get("cache-control"), "no-store");
  assert.match(minted.reviewUrl || "", /^\/pl-review\/\?rid=/);
  const page = new Request(`${ORIGIN}${minted.reviewUrl}`, { headers: { host: "127.0.0.1:43191" } });
  assert.equal((await handle(h, page))?.status, 200);
  const copiedWithoutNonce = new URL(`${ORIGIN}${minted.reviewUrl}`);
  copiedWithoutNonce.searchParams.delete("nonce");
  const copied = new Request(copiedWithoutNonce, { headers: { host: "127.0.0.1:43191" } });
  assert.equal((await handle(h, copied))?.status, 401);
});

test("missing nonce and forged Referer never invoke decision hooks", async () => {
  const h = harness();
  const minted = await mint(h);
  const noNonceUrl = `/pl-review/?rid=${encodeURIComponent("add-auth#proposal.md")}&cwd=${encodeURIComponent(h.cwd)}`;
  const noNonce = decision(noNonceUrl, "/api/approve", JSON.stringify({ feedback: "forge" }));
  assert.equal(isAuthorizedReviewMutation(h.surface, noNonce, new URL(noNonce.url)), false);
  assert.equal((await handle(h, noNonce))?.status, 401);

  const forged = decision(minted.reviewUrl!, "/api/deny", JSON.stringify({ feedback: "forge" }), { referer: `${ORIGIN}/wrong?nonce=x` });
  assert.equal(isAuthorizedReviewMutation(h.surface, forged, new URL(forged.url)), false);
  assert.equal((await handle(h, forged))?.status, 403);
  const wrongHost = decision(minted.reviewUrl!, "/api/approve", JSON.stringify({ feedback: "forge" }), { host: "localhost:9999" });
  assert.equal(isAuthorizedReviewMutation(h.surface, wrongHost, new URL(wrongHost.url)), false);
  assert.equal((await handle(h, wrongHost))?.status, 403);
  assert.equal(h.approvals.length, 0);
  assert.equal(h.denials.length, 0);
});

test("a bound nonce authorizes one decision and rejects replay", async () => {
  const h = harness();
  const { reviewUrl } = await mint(h);
  const req = decision(reviewUrl!, "/api/approve", JSON.stringify({ feedback: "looks good" }));
  assert.equal(isAuthorizedReviewMutation(h.surface, req, new URL(req.url)), true);
  assert.equal((await handle(h, req))?.status, 200);
  assert.equal(h.approvals.length, 1);

  const replay = decision(reviewUrl!, "/api/approve", JSON.stringify({ feedback: "again" }));
  assert.equal(isAuthorizedReviewMutation(h.surface, replay, new URL(replay.url)), false);
  assert.equal((await handle(h, replay))?.status, 401);
  assert.equal(h.approvals.length, 1);
});

test("artifact changes make an authenticated review session stale", async () => {
  const h = harness();
  const { reviewUrl } = await mint(h);
  writeFileSync(join(h.cwd, "openspec", "changes", "add-auth", "proposal.md"), "# changed\n");
  const req = decision(reviewUrl!, "/api/approve", JSON.stringify({ feedback: "stale" }));
  // The capability passes the method gate so the handler can return 409 rather
  // than disguising authenticated staleness as an auth failure.
  assert.equal(isAuthorizedReviewMutation(h.surface, req, new URL(req.url)), true);
  assert.equal((await handle(h, req))?.status, 409);
  assert.equal(h.approvals.length, 0);
});

test("malformed feedback cannot default to denial", async () => {
  const h = harness();
  const first = await mint(h);
  const malformed = decision(first.reviewUrl!, "/api/feedback", "{bad json");
  assert.equal((await handle(h, malformed))?.status, 400);

  const missingDecision = decision(first.reviewUrl!, "/api/feedback", JSON.stringify({ feedback: "ambiguous" }));
  assert.equal((await handle(h, missingDecision))?.status, 400);
  assert.equal(h.denials.length, 0);
  assert.equal(h.approvals.length, 0);
});

test("review body limits reject excessive annotations and strings", async () => {
  const h = harness();
  const first = await mint(h);
  const annotations = Array.from({ length: 101 }, () => ({ comment: "x" }));
  assert.equal((await handle(h, decision(first.reviewUrl!, "/api/deny", JSON.stringify({ annotations }))))?.status, 400);

  const tooLong = "x".repeat(4_001);
  assert.equal((await handle(h, decision(first.reviewUrl!, "/api/deny", JSON.stringify({ feedback: tooLong }))))?.status, 400);
  const oversized = "x".repeat(65_000);
  assert.equal((await handle(h, decision(first.reviewUrl!, "/api/deny", JSON.stringify({ feedback: oversized }))))?.status, 400);
  assert.equal(h.denials.length, 0);
});

test("not-ready and persistence failures return 409 and 500", async () => {
  const notReady = harness({ approve: () => ({ ok: false, error: "automated review not ready" }) });
  const first = await mint(notReady);
  assert.equal((await handle(notReady, decision(first.reviewUrl!, "/api/approve", JSON.stringify({}))))?.status, 409);

  const failing = harness({ throwApprove: true });
  const second = await mint(failing);
  const response = await handle(failing, decision(second.reviewUrl!, "/api/approve", JSON.stringify({}))) as Response;
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("cache-control"), "no-store");
});
