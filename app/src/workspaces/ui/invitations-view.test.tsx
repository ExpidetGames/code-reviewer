// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins the invitations page (#179): one list with one accessible name while invitations wait, and
// exactly one empty state, "No invitations waiting.", while none do.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { InvitationsView } from "./invitations-view.tsx";

afterEach(cleanup);

const ONE = {
  id: "inv-1",
  workspaceName: "Acme",
  role: "member",
  expiresAt: "2026-10-19T08:00:00.000Z",
} as const;

describe("the invitations page", () => {
  // #179-T02
  it("shows one list with one name while invitations wait", () => {
    render(<InvitationsView pending={[ONE]} />);

    const lists = screen.getAllByRole("list");
    expect(lists).toHaveLength(1);
    expect(lists[0]?.getAttribute("aria-label")).toBe("Invitations");
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.getByText("Member")).toBeTruthy();
    expect(screen.getByText(/2026-10-19 08:00 UTC/)).toBeTruthy();
  });

  // #179-T02
  it("shows exactly one empty state while no invitation waits", () => {
    render(<InvitationsView pending={[]} />);

    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getAllByText("No invitations waiting.")).toHaveLength(1);
  });
});
