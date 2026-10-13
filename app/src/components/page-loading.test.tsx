// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins the labelled loading placeholder of a Suspense fallback (#185 review): a polite status region
// with a name, marked busy, drawn as the kit's Skeleton, and able to take an extra size class.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PageLoading } from "./page-loading.tsx";

afterEach(cleanup);

describe("the loading placeholder", () => {
  // #185
  it("is a named, busy status region drawn as a skeleton", () => {
    render(<PageLoading label="Loading the setup" />);

    const status = screen.getByRole("status", { name: "Loading the setup" });
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(status.getAttribute("data-slot")).toBe("skeleton");
  });

  // #185
  it("merges an extra size class", () => {
    render(
      <PageLoading
        label="Loading the user menu"
        className="size-8 rounded-full"
      />,
    );

    const status = screen.getByRole("status", {
      name: "Loading the user menu",
    });
    expect(status.className).toContain("size-8");
    expect(status.className).toContain("rounded-full");
  });
});
