// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the page for a crash in the root layout: it renders its own document with the one h1 of
// the failed page, tries again on request and never prints the error it caught, also in production.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ERROR_COPY } from "@/components/system-page";
import { THEME_ATTRIBUTE, THEME_STORAGE_KEY } from "@/theme/theme";
import GlobalError from "./global-error.tsx";

// next/font only works inside the Next.js build; the class names are all the page needs from it.
vi.mock("./fonts.ts", () => ({ fontVariables: "font-test" }));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  window.localStorage.clear();
  document.documentElement.removeAttribute(THEME_ATTRIBUTE);
});

function crash(): Error & { digest?: string } {
  const error: Error & { digest?: string } = new Error(
    "connect ECONNREFUSED 10.0.0.7:5432",
  );
  error.stack =
    "Error: connect ECONNREFUSED\n    at RootLayout (layout.tsx:12:3)";
  error.digest = "4155470914";
  return error;
}

// Rendered into the document itself: the page brings its own <html> and <body>.
function renderPage(retry: () => void) {
  return render(<GlobalError error={crash()} retry={retry} />, {
    container: document,
  });
}

describe("the page for a crash in the root layout", () => {
  // #637-T01
  it("renders its own document with the failed page and tries again on request", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const retry = vi.fn();
    renderPage(retry);

    expect(document.documentElement.getAttribute("lang")).toBe("en");
    expect(document.documentElement.className).toContain("font-test");
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toBe(ERROR_COPY.title);
    expect(screen.getByText(ERROR_COPY.description)).toBeTruthy();

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: ERROR_COPY.retry }));
    expect(retry).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("link", { name: ERROR_COPY.back }).getAttribute("href"),
    ).toBe("/");
  });

  // #637-T02
  it("shows no message, stack or digest of the error in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderPage(vi.fn());

    const text = document.documentElement.textContent ?? "";
    expect(text).toContain(ERROR_COPY.title);
    expect(text).not.toContain("ECONNREFUSED");
    expect(text).not.toContain("layout.tsx");
    expect(text).not.toContain("4155470914");
  });

  it("keeps the light or dark mode the person chose", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    renderPage(vi.fn());

    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("dark");
  });
});
