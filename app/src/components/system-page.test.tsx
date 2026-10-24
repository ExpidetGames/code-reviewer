// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins down the two system pages: the page that is not found and the page that failed each have the
// one h1 that names the state, the sentence under it and a way back to the start page; the failed page
// tries the page again on request and never prints the error it caught.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import ErrorPage from "../app/error.tsx";
import NotFound from "../app/not-found.tsx";
import { ERROR_COPY, NOT_FOUND_COPY } from "./system-page.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the page that is not found", () => {
  // #633-T03
  it("names the state in its one heading and leads back to the start page", () => {
    render(<NotFound />);

    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toBe(NOT_FOUND_COPY.title);
    expect(screen.getByText(NOT_FOUND_COPY.description)).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: NOT_FOUND_COPY.back })
        .getAttribute("href"),
    ).toBe("/");
  });
});

describe("the page that failed", () => {
  // #633-T03
  it("names the state, tries the page again on request and leads back to the start page", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const retry = vi.fn();
    render(<ErrorPage error={new Error("database is locked")} retry={retry} />);

    expect(
      screen.getByRole("heading", { level: 1, name: ERROR_COPY.title }),
    ).toBeTruthy();
    expect(screen.getByText(ERROR_COPY.description)).toBeTruthy();
    expect(document.body.textContent).not.toContain("database is locked");

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: ERROR_COPY.retry }));
    expect(retry).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("link", { name: ERROR_COPY.back }).getAttribute("href"),
    ).toBe("/");
  });
});
