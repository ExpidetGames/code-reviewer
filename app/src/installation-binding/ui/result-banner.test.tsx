// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the tone of the banner on the GitHub result page: an outcome that is not a failure or a
// success is information, and the page must say so with the neutral `info` tone. The old page rendered
// the warning fallback for every tone that was neither `success` nor `error` (#171).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ResultBanner } from "./result-banner.tsx";

afterEach(cleanup);

describe("the result banner of the GitHub flow", () => {
  // #171-T03
  it("renders an info outcome as an info alert, never the warning fallback", () => {
    render(
      <ResultBanner
        result={{ tone: "info", text: "Choose the installation to connect." }}
      />,
    );

    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Choose the installation to connect.");
    expect(banner.getAttribute("data-variant")).toBe("info");
  });

  it("renders a failure's tone too, but always as a polite status, never an alert", () => {
    const { unmount } = render(
      <ResultBanner
        result={{ tone: "error", text: "Nothing was connected." }}
      />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").getAttribute("data-variant")).toBe(
      "destructive",
    );
    unmount();

    render(
      <ResultBanner
        result={{ tone: "success", text: "GitHub is connected." }}
      />,
    );
    expect(screen.getByRole("status").getAttribute("data-variant")).toBe(
      "success",
    );
  });

  it("says nothing was connected when the code names no outcome", () => {
    render(<ResultBanner result={null} />);

    expect(screen.getByRole("status").textContent).toContain(
      "Nothing was connected.",
    );
  });
});
