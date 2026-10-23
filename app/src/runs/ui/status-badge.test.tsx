// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the status badge: every status has a label of its own and a symbol of its own (a Phosphor
// icon, #636), so no status is told apart by color alone; the run detail can ask for the description
// behind the "?".
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { JOB_STATUSES } from "../../jobs/job-status.ts";
import { RUN_STATUS_PRESENTATION } from "../run-status.ts";
import { RunStatusBadge } from "./status-badge.tsx";

afterEach(cleanup);

describe("the status badge", () => {
  // CR-35-T06
  it("shows a different label and a different symbol for each of the statuses", () => {
    const shown = JOB_STATUSES.map((status) => {
      const { container, unmount } = render(<RunStatusBadge status={status} />);
      const badge = container.firstElementChild;
      const symbol = badge?.querySelector("svg[aria-hidden='true']")?.innerHTML;
      const label = badge?.textContent;
      unmount();
      return {
        status,
        label,
        symbol,
        dataStatus: badge?.getAttribute("data-status"),
      };
    });

    expect(new Set(shown.map((entry) => entry.label)).size).toBe(
      JOB_STATUSES.length,
    );
    expect(new Set(shown.map((entry) => entry.symbol)).size).toBe(
      JOB_STATUSES.length,
    );
    for (const entry of shown) {
      expect(entry.label).toBeTruthy();
      expect(entry.dataStatus).toBe(entry.status);
    }
  });

  // CR-35-T06
  it("hides the symbol from assistive technology so the text alone carries the meaning", () => {
    const { container } = render(<RunStatusBadge status="failed" />);

    expect(container.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    expect(container.textContent).toContain("Failed");
  });

  // #636-T02
  it.each(JOB_STATUSES)(
    "draws the symbol of %s as a Phosphor icon and labels the status in words",
    (status) => {
      const { label } = RUN_STATUS_PRESENTATION[status];
      const { container } = render(<RunStatusBadge status={status} />);
      const badge = container.firstElementChild;
      const icon = badge?.querySelector("svg");

      // Phosphor draws on a 256 unit grid and fills with currentColor; no emoji or text glyph is left.
      expect(icon?.getAttribute("viewBox")).toBe("0 0 256 256");
      expect(icon?.getAttribute("fill")).toBe("currentColor");
      expect(icon?.getAttribute("aria-hidden")).toBe("true");
      // The accessible label of the status is its word, read once: the icon adds no name of its own.
      expect(badge?.textContent).toBe(label);
      expect(screen.getByText(label)).toBe(badge);
    },
  );

  // The list keeps the description reachable with a non-interactive title, not a control per row.
  it("keeps the status description as a title without a second control", () => {
    const { container } = render(<RunStatusBadge status="failed" />);

    expect(container.firstElementChild?.getAttribute("title")).toBe(
      RUN_STATUS_PRESENTATION.failed.description,
    );
    expect(container.querySelector("button")).toBeNull();
  });

  // The description is available from the badge, not printed beside the label.
  it("keeps the status description behind the badge's hint on request", async () => {
    const user = userEvent.setup();
    render(<RunStatusBadge status="failed" hint />);
    expect(
      screen.queryByText(RUN_STATUS_PRESENTATION.failed.description),
    ).toBeNull();

    await user.tab();

    const trigger = screen.getByRole("button", {
      name: "About the status Failed",
    });
    const describedBy = trigger.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? "")?.textContent).toContain(
      RUN_STATUS_PRESENTATION.failed.description,
    );
  });
});
