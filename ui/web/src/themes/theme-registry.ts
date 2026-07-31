export const DASHBOARD_THEMES = [
  { id: "dark", label: "Soft Signal Dusk", renderer: "soft-signal", colorScheme: "dark" },
  { id: "light", label: "Soft Signal Day", renderer: "soft-signal", colorScheme: "light" },
  { id: "terminal", label: "Terminal Operations", renderer: "terminal", colorScheme: "dark" },
] as const;

export type DashboardThemeId = (typeof DASHBOARD_THEMES)[number]["id"];
export type DashboardRendererId = (typeof DASHBOARD_THEMES)[number]["renderer"];
export type DashboardTheme = (typeof DASHBOARD_THEMES)[number];

export const DEFAULT_THEME_ID: DashboardThemeId = "dark";

export function isDashboardThemeId(value: unknown): value is DashboardThemeId {
  return typeof value === "string" && DASHBOARD_THEMES.some((theme) => theme.id === value);
}

export function dashboardTheme(themeId: DashboardThemeId): DashboardTheme {
  return DASHBOARD_THEMES.find((theme) => theme.id === themeId) ?? DASHBOARD_THEMES[0];
}
