import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import Sidebar from "./Sidebar";
import { store } from "../store";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.dataset.theme = "dark";
  store.setState({
    activeTab: "overview",
    connection: "live",
    scope: { level: "fleet" },
    theme: "dark",
    projectGroups: [{
      name: "project-1",
      derivedLabel: "app",
      label: "App Project",
      sessions: [],
      live: true,
      totalCost: 0,
      cwds: ["/workspace/app"],
    }],
    scopedStats: { sessions: 2, live: 1, running: 1, tokens: 0, cost: 0 },
    scopedEvents: [],
    scopedAgentCount: 3,
  });
});

describe("Sidebar", () => {
  it("provides semantic navigation and persists the selected theme", async () => {
    render(<Sidebar />);

    expect(screen.getByRole("navigation", { name: "Dashboard sections" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Overview" })).toHaveAttribute("aria-current", "page");

    await userEvent.click(screen.getByRole("button", { name: /Sessions/ }));
    expect(store.getState().activeTab).toBe("sessions");

    await userEvent.click(screen.getByRole("button", { name: "Light" }));
    expect(store.getState().theme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("hive-theme")).toBe("light");
  });

  it("switches from fleet to project scope and reveals project settings", async () => {
    render(<Sidebar />);

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Project" }), "project-1");

    expect(store.getState().scope).toEqual({ level: "project", project: "project-1" });
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
  });
});
