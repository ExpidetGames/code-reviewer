// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins the invitation-link block (#177, review of #215): the block that holds the link is a static
// note, not a status region, so the only polite live region is the one that announces the copy
// result. A mailed invitation is announced politely on its own.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { InvitationLink } from "./invitation-link.tsx";

afterEach(cleanup);

describe("the invitation link block", () => {
  it("shows the link as a note with exactly one polite region for the copy result", () => {
    render(
      <InvitationLink
        shown={{
          email: "ada@example.test",
          delivery: {
            kind: "link",
            link: "https://reviews.example.test/invitation?token=SECRETTOKEN",
            reason: "no_mail_server",
          },
        }}
      />,
    );

    const note = screen.getByRole("note");
    expect(note.textContent).toMatch(/cannot send mail/);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(note.contains(screen.getByRole("status"))).toBe(true);
  });

  it("announces a mailed invitation politely", () => {
    render(
      <InvitationLink
        shown={{ email: "ada@example.test", delivery: { kind: "mailed" } }}
      />,
    );

    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toMatch(
      /The invitation was sent to ada@example.test/,
    );
  });
});
