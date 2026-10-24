// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins the InfoHint: it is reachable with Tab, the hint is announced through `aria-describedby`
// while it is open, and Escape closes it.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { InfoHint } from "./info-hint.tsx";

afterEach(cleanup);

describe("the info hint", () => {
  // #167-T04
  it("is reached with Tab, announces its text and closes on Escape", async () => {
    const user = userEvent.setup();
    render(
      <InfoHint label="About the review model">
        The model decides the cost and the quality of a review.
      </InfoHint>,
    );

    await user.tab();
    const trigger = screen.getByRole("button", {
      name: "About the review model",
    });
    expect(document.activeElement).toBe(trigger);
    // The hit area is at least 44x44px even though the icon stays small (WCAG 2.5.5).
    expect(trigger.className).toContain("size-11");

    await waitFor(() =>
      expect(trigger.getAttribute("aria-describedby")).toBeTruthy(),
    );
    const describedBy = trigger.getAttribute("aria-describedby")!;
    expect(document.getElementById(describedBy)?.textContent).toContain(
      "The model decides the cost and the quality of a review.",
    );

    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(
        screen.queryByText(
          "The model decides the cost and the quality of a review.",
        ),
      ).toBeNull(),
    );
  });
});
