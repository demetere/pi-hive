import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { openDashboard, openWorkflowDashboard, PROJECT_ID, SESSION_ID } from "./fixtures";

async function expectNoSeriousA11yViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).analyze();
  const blocking = result.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
  expect(blocking, blocking.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`).join("\n")).toEqual([]);
}

test("legacy Overview loads live fleet telemetry", async ({ page }) => {
  await openDashboard(page);
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("Agent Topology")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Execution Lead —/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Builder —/ })).toBeVisible();
});

test("legacy Plans opens an authored artifact in a secure review session", async ({ page }) => {
  const mock = await openDashboard(page); await page.getByRole("button", { name: "Plans" }).click(); await page.getByRole("button", { name: /add-auth/ }).click();
  await expect(page.getByRole("button", { name: /Proposal.*review now/ })).toBeVisible();
  await expect(page.getByText("up next: Design")).toBeVisible();
  await expect(page.getByTitle("Plan review")).toBeVisible();
  await expect.poll(() => mock.mutations.some((entry) => entry.method === "POST" && entry.path === "/review-sessions")).toBe(true);
});

test("legacy Sessions deletes telemetry through the guarded confirmation", async ({ page }) => {
  const mock = await openDashboard(page); await page.getByRole("button", { name: /Sessions/ }).click(); await expect(page.getByRole("cell", { name: /App Project/ })).toBeVisible();
  await page.getByRole("button", { name: /Delete session .* telemetry/ }).click(); const dialog = page.getByRole("alertdialog", { name: "Delete session telemetry?" }); await expect(dialog).toBeVisible(); await dialog.getByRole("button", { name: "Delete session" }).click();
  await expect(dialog).toBeHidden(); await expect.poll(() => mock.mutations.some((entry) => entry.method === "DELETE" && entry.path === `/sessions/${SESSION_ID}`)).toBe(true);
});

test("legacy Settings prunes history after project selection and confirmation", async ({ page }) => {
  const mock = await openDashboard(page); await page.getByRole("combobox", { name: "Project" }).selectOption(PROJECT_ID); await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Storage & prune" })).toBeVisible(); await expect(page.getByText("4.0 KB").first()).toBeVisible(); await page.getByRole("button", { name: "Prune…" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Prune telemetry history?" }); await dialog.getByRole("button", { name: "Prune history" }).click();
  await expect(page.getByText(/Pruned 3 events and 0 sessions/)).toBeVisible(); await expect.poll(() => mock.mutations.some((entry) => entry.method === "POST" && entry.path === "/prune" && (entry.body as any)?.olderThanDays === 30)).toBe(true);
});

test("legacy SSE reconnect reports reconnecting and syncing until catch-up completes", async ({ page }) => {
  await openDashboard(page); await page.evaluate(() => (window as any).__eventSources[0].triggerError()); await expect(page.getByText("reconnecting", { exact: true })).toBeVisible({ timeout: 4_000 }); await page.evaluate(() => (window as any).__eventSources[0].triggerOpen()); await expect(page.getByText("syncing", { exact: true })).toBeVisible(); await expect(page.getByText("Connected", { exact: true })).toBeVisible();
});

test("workflow views are an additive keyboard-reachable legacy tab", async ({ page }) => {
  await openWorkflowDashboard(page);
  for (const view of ["Projects", "Sessions", "Runs", "Topology", "Tasks", "Artifacts", "Evidence", "Questions", "Checkpoints", "Approvals", "Knowledge bundles", "Knowledge jobs", "Knowledge proposals", "Cost", "Model mix", "Usage", "Activity", "History", "Workflows"]) {
    const button = page.getByRole("button", { name: view, exact: true }).last(); await button.focus(); await page.keyboard.press("Enter"); await expect(page.getByRole("heading", { name: view, exact: true }).last()).toBeVisible();
  }
  await expect(page.getByText(/cannot launch workflows or edit configuration/i)).toBeVisible();
});

test("evidence, cost, and model mix render separated bounded telemetry", async ({ page }) => {
  const mock = await openWorkflowDashboard(page);
  await page.getByRole("button", { name: "Evidence", exact: true }).last().click();
  await expect(page.getByRole("list", { name: "Evidence references" })).toContainText("tool-call-7");
  await page.getByRole("navigation", { name: "Workflow dashboard views" }).getByRole("button", { name: "Cost", exact: true }).click();
  await expect(page.getByRole("region", { name: "Cost summary" })).toContainText("Provider-confirmed cost");
  await expect(page.getByRole("region", { name: "Cost summary" })).toContainText("$0.002700");
  await page.getByRole("button", { name: "Model mix", exact: true }).click();
  await expect(page.getByRole("region", { name: "Model mix summary" })).toContainText("provider/model-a");
  expect(mock.workflowRequests.some((request) => request.includes("GET /api/v1/history?") && request.includes("eventType=budget.model.usage.recorded"))).toBe(true);
});

test("topology uses native nested-list semantics and remains keyboard reachable", async ({ page }) => {
  await openWorkflowDashboard(page);
  const topologyButton = page.getByRole("button", { name: "Topology", exact: true }).last();
  await topologyButton.focus(); await page.keyboard.press("Enter");
  const topology = page.getByRole("region", { name: "Topology hierarchy" });
  await expect(topology).toBeVisible();
  await expect(topology.locator("[role=tree], [role=treeitem]")).toHaveCount(0);
  await expect(topology.locator("ul")).toHaveCount(2);
  await expect(topology.locator("li")).toHaveCount(2);
  await expectNoSeriousA11yViolations(page);
});

test("typed question control carries authenticated exact W25 CAS identity", async ({ page }) => {
  const mock = await openWorkflowDashboard(page); await page.getByRole("button", { name: "Questions", exact: true }).last().click(); await page.getByRole("button", { name: "Answer yes" }).click();
  await expect.poll(() => mock.mutations.filter((entry) => entry.path.startsWith("/api/v1/")).length).toBe(1); const mutation = mock.mutations.find((entry) => entry.path === "/api/v1/controls/questions/answer")!;
  expect(mutation).toMatchObject({ method: "POST", body: { projectId: "project-1", sessionId: "session-1", runId: "run-1", questionId: "question-1", expectedState: "pending", value: true, claimedIdentity: "local-dashboard", operationId: expect.any(String) } });
  expect(mutation.headers.authorization).toBe("Bearer browser-test-token"); expect(mutation.headers["x-pi-hive-csrf"]).toBe("csrf-test-token"); expect(mutation.headers["x-pi-hive-api-version"]).toBe("1");
});

test("approval and knowledge decisions retain exact authoritative provenance", async ({ page }) => {
  const mock = await openWorkflowDashboard(page); await page.getByRole("button", { name: "Approvals", exact: true }).last().click(); await page.getByRole("button", { name: "Approve approval-1" }).click();
  await page.getByRole("button", { name: "Knowledge proposals", exact: true }).click(); await page.getByRole("button", { name: "Deny proposal-1" }).click(); await expect.poll(() => mock.mutations.filter((entry) => entry.path.startsWith("/api/v1/")).length).toBe(2);
  const workflowMutations = mock.mutations.filter((entry) => entry.path.startsWith("/api/v1/"));
  expect(workflowMutations[0]).toMatchObject({ path: "/api/v1/controls/approvals/decide", body: { requestId: "approval-1", expectedRequestSequence: 7, digest: `sha256:${"a".repeat(64)}`, expectedWorkspaceHash: `sha256:${"b".repeat(64)}`, decision: "approved" } });
  expect(workflowMutations[1]).toMatchObject({ path: "/api/v1/controls/knowledge/decide", body: { proposalId: "proposal-1", expectedState: "pending", decision: "deny", claimedIdentity: "local-dashboard" } });
});

test("workflow hasMore pagination stops at the 500-row render bound", async ({ page }) => {
  const mock = await openWorkflowDashboard(page, { paginatedTasks: true }); await page.getByRole("button", { name: "Tasks", exact: true }).last().click();
  for (let pageIndex = 1; pageIndex < 5; pageIndex++) await page.getByRole("button", { name: "Load more Tasks" }).click();
  await expect(page.getByRole("button", { name: "Display limit reached" })).toBeDisabled(); await expect(page.locator(".workflow-card")).toHaveCount(500);
  expect(mock.workflowRequests.filter((request) => request.startsWith("GET /api/v1/tasks?")).map((request) => new URL(request.slice(4), "http://local").searchParams.get("cursor"))).toEqual([null, "100", "200", "300", "400"]);
});

test("legacy and workflow desktop/narrow layouts have no serious accessibility issues", async ({ page }) => {
  await openDashboard(page);
  for (const tab of ["Overview", "Sessions", "Plans"] as const) {
    await page.getByRole("button", { name: new RegExp(`^${tab}`, "u") }).click();
    await expectNoSeriousA11yViolations(page);
  }
  await page.getByRole("combobox", { name: "Project" }).selectOption(PROJECT_ID);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expectNoSeriousA11yViolations(page);
  await page.getByRole("button", { name: "Workflows", exact: true }).click();
  await expect(page.locator("main main")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Workflow dashboard content" })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("navigation", { name: "Workflow dashboard views" })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});
