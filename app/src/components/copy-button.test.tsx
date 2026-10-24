// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins the small copy control used for the GitHub App addresses (#185): it puts the value on the
// clipboard, it announces the result in one polite live region named after the button, and a
// refused (or missing) clipboard says so instead of throwing.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyButton } from "./copy-button.tsx";

afterEach(cleanup);

function clipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

describe("the copy button", () => {
  // #185
  it("copies the value on a click and announces it politely", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    clipboard(writeText);
    render(
      <CopyButton
        value="https://cr.test/api/webhooks/github-app"
        label="Copy the Webhook URL"
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Copy the Webhook URL" }),
    );

    expect(writeText).toHaveBeenCalledWith(
      "https://cr.test/api/webhooks/github-app",
    );
    const status = screen.getByRole("status", { name: "Copy the Webhook URL" });
    expect(status.textContent).toBe("Copied.");
  });

  // #185
  it("says the copy did not work when the clipboard refuses", async () => {
    const user = userEvent.setup();
    clipboard(async () => {
      throw new Error("denied");
    });
    render(<CopyButton value="x" label="Copy the address" />);

    await user.click(screen.getByRole("button", { name: "Copy the address" }));

    expect(
      screen.getByRole("status", { name: "Copy the address" }).textContent,
    ).toMatch(/did not work/);
  });
});
