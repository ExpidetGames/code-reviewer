// @vitest-environment jsdom
// Pins down the list of pull requests a person picks from: number, title and author of each open
// pull request, the empty state, and that text from GitHub is only ever shown as text.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PullRequestChoice } from "../service.ts";
import { PullRequestList } from "./pull-request-list.tsx";

afterEach(cleanup);

function choice(
  number: number,
  overrides: Partial<PullRequestChoice> = {},
): PullRequestChoice {
  return {
    number,
    title: `Change ${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
    author: "alice",
    draft: false,
    headRef: "feature",
    baseRef: "main",
    ...overrides,
  };
}

function renderList(
  pullRequests: PullRequestChoice[],
  selected: number | null = null,
  onSelect: (number: number) => void = () => undefined,
) {
  return render(
    <PullRequestList
      pullRequests={pullRequests}
      selected={selected}
      onSelect={onSelect}
      name="pr"
    />,
  );
}

describe("the pull request list", () => {
  it("shows a radio button with number, title and author for every pull request", () => {
    renderList([choice(7, { title: "Add caching", author: "bob" }), choice(3)]);

    expect(
      screen.getByRole("radio", { name: /#7 Add caching by bob/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("radio", { name: /#3 Change 3 by alice/ }),
    ).toBeTruthy();
  });

  it("marks the selected pull request and reports a pick", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderList([choice(7), choice(3)], 3, onSelect);

    const picked = screen.getByRole("radio", {
      name: /#3/,
    }) as HTMLInputElement;
    expect(picked.checked).toBe(true);
    await user.click(screen.getByRole("radio", { name: /#7/ }));

    expect(onSelect).toHaveBeenCalledWith(7);
  });

  it("marks a draft", () => {
    renderList([choice(7, { draft: true })]);

    expect(screen.getByText("Draft")).toBeTruthy();
  });

  // CR-33-T03
  it("explains that there are no open pull requests", () => {
    renderList([]);

    expect(screen.getByText(/There are no open pull requests/)).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  // CR-33-T15
  it("shows a title and an author name with HTML as text and runs nothing", () => {
    const { container } = renderList([
      choice(7, {
        title: "<img src=x onerror=alert(1)>",
        author: "<b>mallory</b>",
      }),
    ]);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(container.textContent).toContain("<b>mallory</b>");
  });

  it("links to GitHub only for addresses on github.com", () => {
    renderList([
      choice(7),
      choice(8, { url: "javascript:alert(1)" }),
      choice(9, { url: "https://evil.test/acme/widgets/pull/9" }),
    ]);

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe(
      "https://github.com/acme/widgets/pull/7",
    );
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer");
  });
});
