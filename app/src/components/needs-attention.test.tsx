// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins the shared "Needs attention" strip (#173): nothing while there is nothing to attend to, one
// region under the name "Needs attention" with a row per notice and no alert role (the strip is static
// content, not a live announcement), and at most `maxRows` rows in the open — the rest go behind a
// disclosure so the strip stays short.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { NeedsAttention, type AttentionNotice } from "./needs-attention.tsx";

afterEach(cleanup);

function notice(id: string, severity: AttentionNotice["severity"] = "error") {
  return {
    id,
    severity,
    title: `Problem ${id}`,
    detail: `Detail ${id}`,
  } satisfies AttentionNotice;
}

function rowCount(region: HTMLElement): number {
  return region.querySelectorAll('[data-slot="attention-row"]').length;
}

describe("the needs attention strip", () => {
  // #173-T01
  it("shows nothing while there is nothing to attend to", () => {
    const { container } = render(<NeedsAttention notices={[]} />);

    expect(container.textContent).toBe("");
    expect(
      screen.queryByRole("region", { name: "Needs attention" }),
    ).toBeNull();
  });

  // #173-T01
  it("is exactly one region named Needs attention, with a row per notice", () => {
    render(<NeedsAttention notices={[notice("a"), notice("b")]} />);

    const region = screen.getByRole("region", { name: "Needs attention" });
    expect(
      screen.getAllByRole("region", { name: "Needs attention" }),
    ).toHaveLength(1);
    expect(within(region).getByText("Problem a")).toBeTruthy();
    expect(within(region).getByText("Detail b")).toBeTruthy();
    expect(rowCount(region)).toBe(2);
  });

  // #173-T01
  it("keeps its rows static: no alert role under the labelled region", () => {
    render(<NeedsAttention notices={[notice("a"), notice("b")]} />);

    const region = screen.getByRole("region", { name: "Needs attention" });
    expect(within(region).queryAllByRole("alert")).toHaveLength(0);
    expect(rowCount(region)).toBe(2);
  });

  // #173-T01
  it("keeps at most maxRows rows open and the rest behind a disclosure", async () => {
    const user = userEvent.setup();
    render(
      <NeedsAttention
        notices={[notice("a"), notice("b"), notice("c")]}
        maxRows={2}
      />,
    );

    // Two open rows: the third is not one of the rows but is still reachable.
    const region = screen.getByRole("region", { name: "Needs attention" });
    expect(rowCount(region)).toBe(2);
    const trigger = screen.getByRole("button", { name: "1 more notice" });
    const content = document.getElementById(
      trigger.getAttribute("aria-controls")!,
    );
    expect(content?.hasAttribute("hidden")).toBe(true);
    expect(content?.textContent).toContain("Problem c");

    await user.click(trigger);

    expect(content?.hasAttribute("hidden")).toBe(false);
  });

  // #180-T01 (the overview shows at most three)
  it("keeps three rows open and the fourth behind a disclosure at maxRows 3", async () => {
    const user = userEvent.setup();
    render(
      <NeedsAttention
        notices={[notice("a"), notice("b"), notice("c"), notice("d")]}
        maxRows={3}
      />,
    );

    const region = screen.getByRole("region", { name: "Needs attention" });
    expect(rowCount(region)).toBe(3);
    const trigger = screen.getByRole("button", { name: "1 more notice" });
    const content = document.getElementById(
      trigger.getAttribute("aria-controls")!,
    );
    expect(content?.hasAttribute("hidden")).toBe(true);
    expect(content?.textContent).toContain("Problem d");

    await user.click(trigger);

    expect(content?.hasAttribute("hidden")).toBe(false);
  });
});
