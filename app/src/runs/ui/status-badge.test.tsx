// @vitest-environment jsdom
// Pins down the status badge: every status has a label of its own and a symbol of its own, so no
// status is told apart by color alone.
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { JOB_STATUSES } from "../../jobs/job-status.ts";
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
      return { status, label, symbol, className: badge?.className };
    });

    expect(new Set(shown.map((entry) => entry.label)).size).toBe(
      JOB_STATUSES.length,
    );
    expect(new Set(shown.map((entry) => entry.symbol)).size).toBe(
      JOB_STATUSES.length,
    );
    for (const entry of shown) {
      expect(entry.label).toBeTruthy();
      expect(entry.className).toContain(`badge-run-${entry.status}`);
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
});
