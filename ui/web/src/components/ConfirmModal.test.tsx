import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ConfirmModal from "./ConfirmModal";
import { store } from "../store";

beforeEach(() => store.setState({ confirm: null }));

describe("ConfirmModal", () => {
  it("exposes alert-dialog semantics and runs the confirmed action", async () => {
    const action = vi.fn(async () => undefined);
    store.setState({
      confirm: {
        title: "Delete telemetry?",
        message: "This cannot be undone.",
        confirmLabel: "Delete telemetry",
        danger: true,
        onConfirm: action,
      },
    });

    render(<ConfirmModal />);
    const dialog = screen.getByRole("alertdialog", { name: "Delete telemetry?" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Delete telemetry" }));
    await waitFor(() => expect(action).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("closes on Escape without running the action", async () => {
    const action = vi.fn();
    store.setState({ confirm: { title: "Prune history?", message: "Old rows", onConfirm: action } });
    render(<ConfirmModal />);

    await userEvent.keyboard("{Escape}");

    expect(action).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
