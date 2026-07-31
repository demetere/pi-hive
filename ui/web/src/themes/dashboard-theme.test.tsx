import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DASHBOARD_THEMES, dashboardTheme, isDashboardThemeId } from "./theme-registry";
import { storedDashboardTheme, useDashboardTheme } from "./use-dashboard-theme";

function ThemeHarness() {
  const { themeId, setThemeId } = useDashboardTheme();
  return <><output>{themeId}</output><button type="button" onClick={() => setThemeId("terminal")}>Use terminal</button></>;
}

describe("dashboard theme registry", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.renderer;
  });

  it("keeps the existing Soft Signal variants and a separate renderer theme", () => {
    expect(DASHBOARD_THEMES.map((theme) => theme.id)).toEqual(["dark", "light", "terminal"]);
    expect(dashboardTheme("dark").renderer).toBe("soft-signal");
    expect(dashboardTheme("terminal").renderer).toBe("terminal");
  });

  it("fails closed to the default for unknown stored themes", () => {
    window.localStorage.setItem("hive-theme", "untrusted-theme");
    expect(isDashboardThemeId("untrusted-theme")).toBe(false);
    expect(storedDashboardTheme()).toBe("dark");
  });

  it("persists theme and renderer selection from the shared hook", async () => {
    render(<ThemeHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Use terminal" }));
    await waitFor(() => expect(document.documentElement.dataset.renderer).toBe("terminal"));
    expect(document.documentElement.dataset.theme).toBe("terminal");
    expect(window.localStorage.getItem("hive-theme")).toBe("terminal");
  });
});
