// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins the application Button: the four variants and the sizes render the matching shadcn button,
// the loading state is announced and cannot be submitted twice, and an icon-only button must have an
// accessible name (and a 44px hit area).
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "./button.tsx";

afterEach(cleanup);

describe("the kit button", () => {
  // #167-T01
  it.each([
    ["primary", "default"],
    ["secondary", "secondary"],
    ["ghost", "ghost"],
    ["destructive", "destructive"],
  ] as const)(
    "renders the %s variant as the shadcn %s variant",
    (variant, shadcnVariant) => {
      render(<Button variant={variant}>Save</Button>);

      expect(
        screen
          .getByRole("button", { name: "Save" })
          .getAttribute("data-variant"),
      ).toBe(shadcnVariant);
    },
  );

  // #167-T01
  it.each(["sm", "default"] as const)("renders the %s size", (size) => {
    render(<Button size={size}>Save</Button>);

    expect(
      screen.getByRole("button", { name: "Save" }).getAttribute("data-size"),
    ).toBe(size);
  });

  // #167-T01
  it("defaults to type=button so it never submits a form by accident", () => {
    render(<Button>Save</Button>);

    expect(
      screen.getByRole("button", { name: "Save" }).getAttribute("type"),
    ).toBe("button");
  });

  // #167-T01
  it("announces the loading label and cannot be submitted twice", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit" loading loadingLabel="Saving">
          Save
        </Button>
      </form>,
    );

    const button = screen.getByRole("button", { name: "Saving" });
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(true);

    await user.dblClick(button);

    expect(onSubmit).not.toHaveBeenCalled();
  });

  // #167-T01
  it("keeps the children as the accessible name when loading has no label", () => {
    render(<Button loading>Save</Button>);

    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  // #167-T02
  it("refuses an icon-only button without an accessible name", () => {
    expect(() =>
      render(
        <Button size="icon">
          <span aria-hidden="true">+</span>
        </Button>,
      ),
    ).toThrow(/aria-label/);
  });

  // #167-T02
  it("accepts an icon-only button with an aria-label and gives it a 44px hit area", () => {
    render(
      <Button size="icon" aria-label="Add project">
        <span aria-hidden="true">+</span>
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Add project" });
    expect(button.className).toContain("size-11");
  });
});
