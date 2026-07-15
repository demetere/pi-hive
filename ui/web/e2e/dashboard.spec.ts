import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { openDashboard, PROJECT_ID, SESSION_ID } from "./fixtures";

async function expectNoSeriousA11yViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).analyze();
  const blocking = result.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
  expect(blocking, blocking.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`).join("\n")).toEqual([]);
}

test("Overview loads live fleet telemetry", async ({ page }) => {
  await openDashboard(page);

  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("Agent Topology")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Execution Lead —/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Builder —/ })).toBeVisible();
});

test("Plans opens an authored artifact in a secure review session", async ({ page }) => {
  const mock = await openDashboard(page);
  await page.getByRole("button", { name: "Plans" }).click();
  await page.getByRole("button", { name: /add-auth/ }).click();

  await expect(page.getByRole("button", { name: /Proposal.*review now/ })).toBeVisible();
  await expect(page.getByText("up next: Design")).toBeVisible();
  await expect(page.getByTitle("Plan review")).toBeVisible();
  await expect.poll(() => mock.mutations.some((entry) => entry.method === "POST" && entry.path === "/review-sessions")).toBe(true);
});

test("Sessions deletes telemetry through the guarded confirmation", async ({ page }) => {
  const mock = await openDashboard(page);
  await page.getByRole("button", { name: /Sessions/ }).click();
  await expect(page.getByRole("cell", { name: /App Project/ })).toBeVisible();

  await page.getByRole("button", { name: /Delete session .* telemetry/ }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete session telemetry?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Delete session" }).click();

  await expect(dialog).toBeHidden();
  await expect.poll(() => mock.mutations.some((entry) => entry.method === "DELETE" && entry.path === `/sessions/${SESSION_ID}`)).toBe(true);
});

test("Settings prunes history after project selection and confirmation", async ({ page }) => {
  const mock = await openDashboard(page);
  await page.getByRole("combobox", { name: "Project" }).selectOption(PROJECT_ID);
  await page.getByRole("button", { name: "Settings" }).click();

  await expect(page.getByRole("heading", { name: "Storage & prune" })).toBeVisible();
  await expect(page.getByText("4.0 KB").first()).toBeVisible();
  await page.getByRole("button", { name: "Prune…" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Prune telemetry history?" });
  await dialog.getByRole("button", { name: "Prune history" }).click();

  await expect(page.getByText(/Pruned 3 events and 0 sessions/)).toBeVisible();
  await expect.poll(() => mock.mutations.some((entry) => entry.method === "POST" && entry.path === "/prune" && (entry.body as any)?.olderThanDays === 30)).toBe(true);
});

test("SSE reconnect reports reconnecting and syncing until catch-up completes", async ({ page }) => {
  await openDashboard(page);

  await page.evaluate(() => (window as any).__eventSources[0].triggerError());
  await expect(page.getByText("reconnecting", { exact: true })).toBeVisible({ timeout: 4_000 });
  await page.evaluate(() => (window as any).__eventSources[0].triggerOpen());
  await expect(page.getByText("syncing", { exact: true })).toBeVisible();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
});

test("core dashboard workflows have no serious or critical axe violations", async ({ page }) => {
  await openDashboard(page);
  await expectNoSeriousA11yViolations(page);

  await page.getByRole("button", { name: /Sessions/ }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  await page.getByRole("button", { name: "Plans" }).click();
  await expect(page.getByText("OpenSpec changes", { exact: true })).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  await page.getByRole("combobox", { name: "Project" }).selectOption(PROJECT_ID);
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});
