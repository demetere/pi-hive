import type { ReactNode } from "react";
import type { DashboardView } from "../dashboard/navigation";
import type { DashboardRendererId, DashboardThemeId } from "../themes/theme-registry";
import SoftSignalShell from "./soft-signal-shell";
import TerminalShell from "./terminal-shell";

export type StreamState = "connecting" | "live" | "resyncing";

export interface ProjectOption {
  readonly projectId: string;
  readonly projectLabel: string;
  readonly syncStatus: "live" | "historical";
}

export interface DashboardShellProps {
  readonly children: ReactNode;
  readonly view: DashboardView;
  readonly projectLabel: string;
  readonly projectScope: string;
  readonly projectOptions: readonly ProjectOption[];
  readonly streamState: StreamState;
  readonly themeId: DashboardThemeId;
  readonly now: Date;
  readonly navCounts: Readonly<Partial<Record<DashboardView, number>>>;
  readonly onNavigate: (view: DashboardView) => void;
  readonly onProjectChange: (projectId: string) => void;
  readonly onThemeChange: (themeId: DashboardThemeId) => void;
}

const SHELLS: Readonly<Record<DashboardRendererId, (props: DashboardShellProps) => ReactNode>> = {
  "soft-signal": SoftSignalShell,
  terminal: TerminalShell,
};

export default function DashboardShell({ renderer, ...props }: DashboardShellProps & { readonly renderer: DashboardRendererId }) {
  const Shell = SHELLS[renderer];
  return <Shell {...props} />;
}
