import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { openDashboard } from "./fixtures";

async function expectNoSeriousA11yViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).analyze();
  const blocking = result.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
  expect(blocking, blocking.map((value) => `${value.id}: ${value.help} (${value.nodes.length})`).join("\n")).toEqual([]);
}

test("workflow-only dashboard starts on bounded workflow state and API v1", async ({ page }) => {
  const mock = await openDashboard(page);
  await expect(page.getByRole("heading", { name: "Workflows", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "custom-delivery" })).toBeVisible();
  await expect(page.getByText(/stream live/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /Overview|Plans|Settings/ })).toHaveCount(0);
  expect(mock.workflowRequests.every((request) => request.includes("/api/v1/"))).toBe(true);
});

test("every workflow view is keyboard reachable without a legacy tab", async ({ page }) => {
  await openDashboard(page);
  for (const view of ["Projects", "Sessions", "Runs", "Topology", "Tasks", "Artifacts", "Evidence", "Questions", "Checkpoints", "Approvals", "Knowledge bundles", "Knowledge jobs", "Knowledge proposals", "Cost", "Model mix", "Usage", "Activity", "History", "Workflows"]) {
    const button = page.getByRole("button", { name: view, exact: true });
    await button.focus(); await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: view, exact: true })).toBeVisible();
  }
  await expect(page.getByText(/cannot launch workflows or edit configuration/i)).toBeVisible();
});

test("evidence, cost, and model mix render separated bounded telemetry", async ({ page }) => {
  const mock = await openDashboard(page);
  await page.getByRole("button", { name: "Evidence", exact: true }).click();
  await expect(page.getByRole("list", { name: "Evidence references" })).toContainText("tool-call-7");
  await page.getByRole("button", { name: "Cost", exact: true }).click();
  await expect(page.getByRole("region", { name: "Cost summary" })).toContainText("Provider-confirmed cost");
  await expect(page.getByRole("region", { name: "Cost summary" })).toContainText("$0.002700");
  await page.getByRole("button", { name: "Model mix", exact: true }).click();
  await expect(page.getByRole("region", { name: "Model mix summary" })).toContainText("provider/model-a");
  expect(mock.workflowRequests.some((request) => request.includes("GET /api/v1/history?") && request.includes("eventType=budget.model.usage.recorded"))).toBe(true);
});

test("topology uses native nested-list semantics and remains keyboard reachable", async ({ page }) => {
  await openDashboard(page);
  const button = page.getByRole("button", { name: "Topology", exact: true });
  await button.focus(); await page.keyboard.press("Enter");
  const topology = page.getByRole("region", { name: "Topology hierarchy" });
  await expect(topology).toBeVisible();
  await expect(topology.locator("[role=tree], [role=treeitem]")).toHaveCount(0);
  await expect(topology.locator("ul")).toHaveCount(2);
  await expect(topology.locator("li")).toHaveCount(2);
  await expectNoSeriousA11yViolations(page);
});

test("typed question control carries authenticated exact CAS identity", async ({ page }) => {
  const mock = await openDashboard(page);
  await page.getByRole("button", { name: "Questions", exact: true }).click();
  await page.getByRole("button", { name: "Answer yes" }).click();
  await expect.poll(() => mock.mutations.filter((entry) => entry.path.startsWith("/api/v1/")).length).toBe(1);
  const mutation = mock.mutations.find((entry) => entry.path === "/api/v1/controls/questions/answer")!;
  expect(mutation).toMatchObject({ method: "POST", body: { projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: "question-1", expectedState: "pending", value: true, claimedIdentity: "local-dashboard", operationId: expect.any(String) } });
  expect(mutation.headers.authorization).toBe("Bearer browser-test-token");
  expect(mutation.headers["x-pi-hive-csrf"]).toBe("csrf-test-token");
  expect(mutation.headers["x-pi-hive-api-version"]).toBe("1");
});

test("approval and knowledge decisions retain exact authoritative provenance", async ({ page }) => {
  const mock = await openDashboard(page);
  await page.getByRole("button", { name: "Approvals", exact: true }).click();
  await page.getByRole("button", { name: "Approve approval-1" }).click();
  await page.getByRole("button", { name: "Knowledge proposals", exact: true }).click();
  await page.getByRole("button", { name: "Deny proposal-1" }).click();
  await expect.poll(() => mock.mutations.filter((entry) => entry.path.startsWith("/api/v1/")).length).toBe(2);
  const mutations = mock.mutations.filter((entry) => entry.path.startsWith("/api/v1/"));
  expect(mutations[0]).toMatchObject({ path: "/api/v1/controls/approvals/decide", body: { requestId: "approval-1", expectedRequestSequence: 7, digest: `sha256:${"a".repeat(64)}`, expectedWorkspaceHash: `sha256:${"b".repeat(64)}`, decision: "approved" } });
  expect(mutations[1]).toMatchObject({ path: "/api/v1/controls/knowledge/decide", body: { proposalId: "proposal-1", expectedState: "pending", decision: "deny", claimedIdentity: "local-dashboard" } });
});

test("hasMore pagination stops at the 500-row render bound", async ({ page }) => {
  const mock = await openDashboard(page, { paginatedTasks: true });
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  for (let pageIndex = 1; pageIndex < 5; pageIndex++) await page.getByRole("button", { name: "Load more Tasks" }).click();
  await expect(page.getByRole("button", { name: "Display limit reached" })).toBeDisabled();
  await expect(page.locator(".workflow-card")).toHaveCount(500);
  expect(mock.workflowRequests.filter((request) => request.startsWith("GET /api/v1/tasks?")).map((request) => new URL(request.slice(4), "http://local").searchParams.get("cursor"))).toEqual([null, "100", "200", "300", "400"]);
});

test("workflow desktop and narrow layouts have no serious accessibility issues", async ({ page }) => {
  await openDashboard(page);
  for (const view of ["Workflows", "Topology", "Questions", "Approvals"] as const) {
    await page.getByRole("button", { name: view, exact: true }).click();
    await expectNoSeriousA11yViolations(page);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("navigation", { name: "Workflow dashboard views" })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});
