// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins the Dialog primitive: opening it moves the focus inside, Tab stays trapped in it, and closing
// (Escape or the close button) returns the focus to the element that opened it.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog.tsx";

afterEach(cleanup);

function Example() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button">Open</button>
      </DialogTrigger>
      <DialogContent showCloseButton={false}>
        <DialogTitle>Delete the workspace</DialogTitle>
        <DialogDescription>This cannot be undone.</DialogDescription>
        <input aria-label="Confirmation" />
        <DialogClose asChild>
          <button type="button">Cancel</button>
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}

describe("the dialog primitive", () => {
  // #167-T03
  it("keeps the focus inside while Tab cycles and returns it to the opener on Escape", async () => {
    const user = userEvent.setup();
    render(<Example />);
    const opener = screen.getByRole("button", { name: "Open" });

    await user.click(opener);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(dialog.contains(document.activeElement)).toBe(true),
    );

    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  // #167-T03
  it("closes from its own close button and returns the focus to the opener", async () => {
    const user = userEvent.setup();
    render(<Example />);
    const opener = screen.getByRole("button", { name: "Open" });
    await user.click(opener);
    await screen.findByRole("dialog");

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });
});
