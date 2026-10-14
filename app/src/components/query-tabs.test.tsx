// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins the query-string tabs: the active tab follows `?tab=`, a missing or unknown value falls back
// to the first tab, and selecting a tab writes it back to the query string.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  replace: vi.fn(),
  pathname: "/w/acme/settings",
  search: "",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigation.replace }),
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

import { QueryTabs } from "./query-tabs.tsx";

afterEach(cleanup);

beforeEach(() => {
  navigation.replace.mockClear();
  navigation.search = "";
});

const items = [
  { value: "general", label: "General", content: "General content" },
  { value: "model", label: "Model", content: "Model content" },
] as const;

describe("the query-string tabs", () => {
  // #167-T05
  it("falls back to the first tab when the query string names none", () => {
    render(<QueryTabs items={items} aria-label="Settings" />);

    expect(
      screen.getByRole("tab", { name: "General" }).getAttribute("data-state"),
    ).toBe("active");
    expect(screen.getByText("General content")).toBeTruthy();
  });

  // #167-T05
  it("follows the query string and ignores an unknown value", () => {
    navigation.search = "?tab=model";
    const { unmount } = render(
      <QueryTabs items={items} aria-label="Settings" />,
    );
    expect(
      screen.getByRole("tab", { name: "Model" }).getAttribute("data-state"),
    ).toBe("active");
    unmount();

    navigation.search = "?tab=nope";
    render(<QueryTabs items={items} aria-label="Settings" />);
    expect(
      screen.getByRole("tab", { name: "General" }).getAttribute("data-state"),
    ).toBe("active");
  });

  // #167-T05
  it("writes the chosen tab back to the query string", async () => {
    const user = userEvent.setup();
    render(<QueryTabs items={items} aria-label="Settings" />);

    await user.click(screen.getByRole("tab", { name: "Model" }));

    expect(navigation.replace).toHaveBeenCalledWith(
      "/w/acme/settings?tab=model",
      { scroll: false },
    );
  });
});
