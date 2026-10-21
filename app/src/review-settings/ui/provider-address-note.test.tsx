// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// What the settings page tells about the address a project pinned for its catalog provider (#588): the pinned address, read
// only; the way it differs from what the catalog trusts now; and the one explicit action that pins the new address.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderAddressView } from "../provider-pin.ts";
import { ProviderAddressNote } from "./provider-address-note.tsx";

afterEach(cleanup);

const OLD = "https://api.deepseek.example";
const NEW = "https://api.deepseek-new.example";

function show(address: ProviderAddressView, confirm = false) {
  const onConfirmChange = vi.fn();
  render(
    <ProviderAddressNote
      address={address}
      confirm={confirm}
      disabled={false}
      onConfirmChange={onConfirmChange}
    />,
  );
  return { onConfirmChange };
}

describe("the pinned address of a catalog provider on the settings page", () => {
  // #588-T28
  it("shows the pinned address as text and offers no action while it is the one the catalog trusts", () => {
    show({ pinned: OLD, current: OLD, state: "pinned" });

    expect(screen.getByText(OLD)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // #588-T28
  it("says a selection without a pin is pinned by its next review, naming the address", () => {
    show({ pinned: null, current: OLD, state: "unpinned" });

    expect(screen.getByText(/fixed at the next review/i)).toBeTruthy();
    expect(screen.getByText(OLD)).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  // #588-T29
  it("warns when the catalog trusts another address now, shows both, and says reviews are refused until it is confirmed", () => {
    show({ pinned: OLD, current: NEW, state: "changed" });

    const warning = screen.getByRole("alert");
    expect(warning.textContent).toMatch(/changed/i);
    expect(warning.textContent).toMatch(/Owner or Admin/);
    expect(warning.textContent).toContain(OLD);
    expect(warning.textContent).toContain(NEW);
    expect(warning.textContent).toMatch(/refused/i);
  });

  // #588-T29
  it("lets the person confirm the new address with a checkbox that the save sends", async () => {
    const { onConfirmChange } = show({
      pinned: OLD,
      current: NEW,
      state: "changed",
    });

    await userEvent.click(
      screen.getByRole("checkbox", { name: /confirm the new address/i }),
    );

    expect(onConfirmChange).toHaveBeenCalledWith(true);
  });

  // #588-T29
  it("offers no action when the catalog trusts no address for the provider now", () => {
    show({ pinned: OLD, current: null, state: "unavailable" });

    expect(screen.getByRole("alert").textContent).toMatch(/no usable address/i);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
