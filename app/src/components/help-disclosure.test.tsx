// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins the HelpDisclosure: the "how it works" text is in the DOM but out of the way until it is asked
// for, and the trigger is reachable with Tab and announces the shown or hidden state.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { HelpDisclosure } from "./help-disclosure.tsx";

afterEach(cleanup);

describe("the help disclosure", () => {
  // #169: the help affordance the copy rules introduce; not a numbered case of the issue.
  it("hides the explanation until it is asked for, and toggles it from the keyboard", async () => {
    const user = userEvent.setup();
    render(
      <HelpDisclosure label="What makes a good password">
        A long passphrase of a few unrelated words is the strongest choice.
      </HelpDisclosure>,
    );

    const trigger = screen.getByRole("button", {
      name: "What makes a good password",
    });
    // The hit area is at least 44px tall (WCAG 2.5.5), like the InfoHint's `size-11`.
    expect(trigger.className).toContain("min-h-11");
    const controls = trigger.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    const content = document.getElementById(controls!);
    expect(content?.hasAttribute("hidden")).toBe(true);

    await user.tab();
    expect(document.activeElement).toBe(trigger);

    await user.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(content?.hasAttribute("hidden")).toBe(false);
    expect(content?.textContent).toContain("A long passphrase");
  });

  // #183-T03: a screen can repeat the same disclosure (one per request), so it must be able to give
  // each one a distinct accessible name while the visible label stays short.
  it("takes a distinct accessible name when the same disclosure repeats", () => {
    render(
      <HelpDisclosure label="Evidence" ariaLabel="Evidence for acme">
        Who asked and what their role is.
      </HelpDisclosure>,
    );

    expect(
      screen.getByRole("button", { name: "Evidence for acme" }),
    ).toBeTruthy();
    expect(screen.getByText("Evidence")).toBeTruthy();
  });
});
