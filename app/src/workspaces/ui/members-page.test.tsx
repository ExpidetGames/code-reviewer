// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down what the Members page offers each role: an Owner changes roles, removes anybody and invites with
// any role; an Admin removes Members and invites Members; a Member sees the members and can leave. The
// buttons only show what the rules allow; the routes decide again (src/workspaces/members.integration.test.ts
// and the route tests). Names and addresses are text somebody else typed, shown as text.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigation.refresh, push: navigation.push }),
}));

import type { Member } from "../../db/repositories/workspace-members-repository.ts";
import type { WorkspaceRole } from "../roles.ts";
import type { WorkspaceApi } from "./api.ts";
import { MembersPageContent, type MembersPageData } from "./members-page.tsx";

afterEach(() => {
  cleanup();
  navigation.refresh.mockClear();
  navigation.push.mockClear();
});

const member = (id: string, role: WorkspaceRole, name = id): Member => ({
  userId: id,
  name,
  email: `${id}@example.test`,
  role,
  joinedAt: "2026-10-12T08:00:00.000Z",
});

const DATA: MembersPageData = {
  members: [
    member("owner-1", "owner"),
    member("admin-1", "admin"),
    member("member-1", "member", "<b>Bold</b> Person"),
  ],
  invitations: [
    {
      id: "inv-1",
      email: "invited@example.test",
      role: "member",
      createdAt: "2026-10-12T08:00:00.000Z",
      expiresAt: "2026-10-19T08:00:00.000Z",
      expired: false,
    },
    {
      id: "inv-2",
      email: "invited-admin@example.test",
      role: "admin",
      createdAt: "2026-10-12T08:00:00.000Z",
      expiresAt: "2026-10-19T08:00:00.000Z",
      expired: false,
    },
  ],
  mailConfigured: false,
};

function fakeApi(): WorkspaceApi {
  const ok = { ok: true } as const;
  return {
    rename: vi.fn(
      async () => ({ ok: true, data: { ok: true, name: "x" } }) as never,
    ),
    changeRole: vi.fn(
      async () => ({ ...ok, data: { ok: true, changed: true } }) as never,
    ),
    removeMember: vi.fn(
      async () => ({ ...ok, data: { ok: true, left: false } }) as never,
    ),
    invite: vi.fn(async () => ({ ...ok, data: {} }) as never),
    revokeInvitation: vi.fn(
      async () => ({ ...ok, data: { ok: true } }) as never,
    ),
    resendInvitation: vi.fn(async () => ({ ...ok, data: {} }) as never),
  };
}

function renderFor(
  role: WorkspaceRole,
  viewerId: string,
  data = DATA,
  api = fakeApi(),
) {
  render(
    <MembersPageContent
      workspaceSlug="acme"
      viewerId={viewerId}
      viewerRole={role}
      data={role === "member" ? { ...data, invitations: null } : data}
      api={api}
    />,
  );
  return api;
}

describe("the Members page for an Owner", () => {
  // #101-WM-27
  it("offers a role for every member, a button to remove everybody else, and the three roles to invite with", () => {
    renderFor("owner", "owner-1");

    const roles = screen.getAllByRole("combobox", { name: /^Role of / });
    expect(roles).toHaveLength(3);
    expect(
      screen.getByRole("button", { name: "Remove admin-1@example.test" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Remove member-1@example.test" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Remove owner-1@example.test" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Leave" })).toBeTruthy();
    const invite = screen.getByRole("form", { name: "Invite a person" });
    expect(
      within(invite)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Owner", "Admin", "Member"]);
  });

  // #101-WM-27
  it("calls the route to change a role and to remove a member, and shows the page data again", async () => {
    const user = userEvent.setup();
    const api = renderFor("owner", "owner-1");

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Role of member-1@example.test" }),
      "admin",
    );
    await user.click(
      screen.getByRole("button", { name: "Remove admin-1@example.test" }),
    );

    expect(api.changeRole).toHaveBeenCalledWith("member-1", "admin");
    expect(api.removeMember).toHaveBeenCalledWith("admin-1");
    await waitFor(() => expect(navigation.refresh).toHaveBeenCalledTimes(2));
  });

  it("shows a refusal as a sentence, never as a code", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    vi.mocked(api.changeRole).mockResolvedValue({
      ok: false,
      status: 409,
      code: "last_owner",
      issues: [],
    });
    renderFor("owner", "owner-1", DATA, api);

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Role of owner-1@example.test" }),
      "member",
    );

    expect((await screen.findByRole("alert")).textContent).toBe(
      "A workspace needs an Owner. Make somebody else an Owner first.",
    );
  });

  it("leaves to the start page after leaving", async () => {
    const user = userEvent.setup();
    renderFor("owner", "owner-1");

    await user.click(screen.getByRole("button", { name: "Leave" }));

    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/"));
  });
});

describe("the Members page for an Admin", () => {
  // #101-WM-11
  it("shows the roles as text, removes Members only, invites Members only and handles the invitations of Members only", () => {
    renderFor("admin", "admin-1");

    expect(screen.queryAllByRole("combobox", { name: /^Role of / })).toEqual(
      [],
    );
    expect(
      screen.getByRole("button", { name: "Remove member-1@example.test" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Remove owner-1@example.test" }),
    ).toBeNull();
    const invite = screen.getByRole("form", { name: "Invite a person" });
    expect(
      within(invite)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Member"]);
    expect(
      screen.getByRole("button", {
        name: "Revoke the invitation for invited@example.test",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Revoke the invitation for invited-admin@example.test",
      }),
    ).toBeNull();
  });
});

describe("the Members page for a Member", () => {
  // #101-WM-11
  it("shows the members and offers nothing but leaving: no invitations, no invite form, no removing", () => {
    renderFor("member", "member-1");

    expect(screen.getAllByRole("listitem").length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByRole("form", { name: "Invite a person" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Invitations" })).toBeNull();
    expect(screen.queryAllByRole("combobox")).toEqual([]);
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
    expect(screen.getByRole("button", { name: "Leave" })).toBeTruthy();
  });

  // #101-SEC-XSS
  it("renders a name with markup as text", () => {
    renderFor("member", "member-1");

    expect(screen.getByText("<b>Bold</b> Person")).toBeTruthy();
    expect(document.querySelector("b")).toBeNull();
  });
});

describe("inviting from the page", () => {
  // #101-WM-13
  it("shows the link once for copying when the instance cannot send mail, and not again after the next invitation", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    vi.mocked(api.invite)
      .mockResolvedValueOnce({
        ok: true,
        data: {
          ok: true,
          invitation: { ...DATA.invitations![0]!, email: "new@example.test" },
          delivery: {
            kind: "link",
            link: "https://reviews.example.test/invitation?token=SECRETTOKEN",
            reason: "no_mail_server",
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          ok: true,
          invitation: { ...DATA.invitations![0]!, email: "other@example.test" },
          delivery: { kind: "mailed" },
        },
      });
    renderFor("owner", "owner-1", DATA, api);

    await user.type(screen.getByLabelText("Email address"), "new@example.test");
    await user.click(screen.getByRole("button", { name: "Send invitation" }));

    const field = await screen.findByLabelText("Invitation link");
    expect((field as HTMLInputElement).value).toContain("SECRETTOKEN");
    expect(api.invite).toHaveBeenCalledWith("new@example.test", "member");

    await user.type(
      screen.getByLabelText("Email address"),
      "other@example.test",
    );
    await user.click(screen.getByRole("button", { name: "Send invitation" }));

    await screen.findByText(/The invitation was sent to other@example.test/);
    expect(screen.queryByLabelText("Invitation link")).toBeNull();
    expect(document.body.textContent).not.toContain("SECRETTOKEN");
  });

  it("says a refusal in a sentence", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    vi.mocked(api.invite).mockResolvedValue({
      ok: false,
      status: 422,
      code: "email_not_allowed",
      issues: [],
    });
    renderFor("owner", "owner-1", DATA, api);

    await user.type(screen.getByLabelText("Email address"), "x@y.test");
    await user.click(screen.getByRole("button", { name: "Send invitation" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /sign-up rule of this instance does not let that address in/,
    );
  });

  it("offers to send an invitation again only when the instance can send mail", () => {
    renderFor("owner", "owner-1");
    expect(screen.queryByRole("button", { name: /again$/ })).toBeNull();
    cleanup();

    renderFor("owner", "owner-1", { ...DATA, mailConfigured: true });

    expect(screen.getAllByRole("button", { name: /again$/ })).toHaveLength(2);
  });
});
