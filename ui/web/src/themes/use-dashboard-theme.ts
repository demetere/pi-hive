import { useEffect, useState } from "react";
import { DEFAULT_THEME_ID, dashboardTheme, isDashboardThemeId, type DashboardThemeId } from "./theme-registry";

const THEME_STORAGE_KEY = "hive-theme";

export function storedDashboardTheme(): DashboardThemeId {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isDashboardThemeId(stored) ? stored : DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

export function useDashboardTheme() {
  const [themeId, setThemeId] = useState<DashboardThemeId>(storedDashboardTheme);
  const theme = dashboardTheme(themeId);

  useEffect(() => {
    document.documentElement.dataset.theme = theme.id;
    document.documentElement.dataset.renderer = theme.renderer;
    try { window.localStorage.setItem(THEME_STORAGE_KEY, theme.id); } catch { /* storage unavailable */ }
  }, [theme]);

  return { theme, themeId, setThemeId } as const;
}
