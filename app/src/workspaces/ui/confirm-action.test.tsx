// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins the row confirmation (#177): a destructive row action only runs its call after the confirming
// button inside the dialog, and cancelling leaves the call alone.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmAction } from "./confirm-action.tsx";

afterEach(cleanup);

describe("the row confirmation", () => {
  // #177 (R23, destructive actions confirmed)
  it("runs the call only after the confirming button, and not on cancel", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmAction
        actionLabel="Remove"
        actionName="Remove ada@example.test"
        title="Remove ada@example.test?"
        description="They lose access to this workspace at once."
        confirmLabel="Remove"
        onConfirm={onConfirm}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Remove ada@example.test" }),
    );
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(onConfirm).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Remove ada@example.test" }),
    );
    await user.click(await screen.findByRole("button", { name: "Remove" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
