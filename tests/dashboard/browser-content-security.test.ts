import assert from "node:assert/strict";
import { test } from "node:test";
import { REVIEW_IFRAME_SANDBOX, safeArtifactHref } from "../../ui/web/src/security.ts";

test("review iframe sandbox keeps an opaque origin", () => {
  const permissions = new Set(REVIEW_IFRAME_SANDBOX.split(/\s+/));
  assert.equal(permissions.has("allow-scripts"), true);
  assert.equal(permissions.has("allow-same-origin"), false);
  assert.equal(permissions.has("allow-popups"), false);
  assert.equal(permissions.has("allow-top-navigation"), false);
});

test("artifact Markdown links reject executable and local-action schemes", () => {
  assert.equal(safeArtifactHref("javascript:alert(1)"), undefined);
  assert.equal(safeArtifactHref("data:text/html,<script>alert(1)</script>"), undefined);
  assert.equal(safeArtifactHref("/shutdown"), undefined);
  assert.equal(safeArtifactHref("https://example.com/docs"), "https://example.com/docs");
  assert.equal(safeArtifactHref("mailto:security@example.com"), "mailto:security@example.com");
  assert.equal(safeArtifactHref("#section"), "#section");
});
