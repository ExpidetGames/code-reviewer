// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the status badge: every status has a label of its own and a symbol of its own, so no
// status is told apart by color alone; the run detail can ask for the description behind the "?".
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
      const symbol = badge?.querySelector("[aria-hidden='true']")?.textContent;
      const label = badge?.textContent?.replace(symbol ?? "", "");
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

    expect(
      container.querySelector("[aria-hidden='true']")?.textContent,
    ).not.toBe("");
    expect(container.textContent).toContain("Failed");
  });

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
