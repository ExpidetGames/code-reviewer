// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down what the Members page offers each role: an Owner changes roles, removes anybody and invites with
// any role; an Admin removes Members and invites Members; a Member sees the members and can leave. The
// buttons only show what the rules allow; the routes decide again (src/workspaces/members.integration.test.ts
// and the route tests). Names and addresses are text somebody else typed, shown as text. The redesign (#177)
// gives each of the two jobs one card, keeps the empty state of the invitations at the card and makes the
// role help reachable with the keyboard.
import {
  cleanup,
  fireEvent,
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
import { InviteForm } from "./invite-form.tsx";
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
  githubAccountId: null,
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

/** Picks an option of a kit Select, whose options only exist while it is open. */
async function choose(
  user: ReturnType<typeof userEvent.setup>,
  combobox: HTMLElement,
  option: string,
) {
  await user.click(combobox);
  await user.click(await screen.findByRole("option", { name: option }));
}

describe("the Members page for an Owner", () => {
  // #101-WM-27
  it("offers a role for every member, a button to remove everybody else, and the three roles to invite with", async () => {
    const user = userEvent.setup();
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
    await user.click(within(invite).getByRole("combobox", { name: "Role" }));
    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["Owner", "Admin", "Member"]);
  });

  // #101-WM-27
  it("calls the route to change a role and to remove a member, and shows the page data again", async () => {
    const user = userEvent.setup();
    const api = renderFor("owner", "owner-1");

    await choose(
      user,
      screen.getByRole("combobox", { name: "Role of member-1@example.test" }),
      "Admin",
    );
    await user.click(
      screen.getByRole("button", { name: "Remove admin-1@example.test" }),
    );
    // Removing a member is destructive: it is confirmed in a dialog first.
    await user.click(await screen.findByRole("button", { name: "Remove" }));

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

    await choose(
      user,
      screen.getByRole("combobox", { name: "Role of owner-1@example.test" }),
      "Member",
    );

    expect((await screen.findByRole("alert")).textContent).toBe(
      "A workspace needs an Owner. Make somebody else an Owner first.",
    );
  });

  it("leaves to the start page after leaving", async () => {
    const user = userEvent.setup();
    renderFor("owner", "owner-1");

    await user.click(screen.getByRole("button", { name: "Leave" }));
    await user.click(
      await screen.findByRole("button", { name: "Leave the workspace" }),
    );

    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/"));
  });

  // #177-T01
  it("makes the role select editable for an Owner and plain text for a Member", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderFor("owner", "owner-1", DATA, api);

    await choose(
      user,
      screen.getByRole("combobox", { name: "Role of member-1@example.test" }),
      "Admin",
    );
    expect(api.changeRole).toHaveBeenCalledWith("member-1", "admin");

    cleanup();
    renderFor("member", "member-1");

    expect(screen.queryAllByRole("combobox")).toEqual([]);
    expect(screen.getAllByText("Member").length).toBeGreaterThanOrEqual(1);
  });
});

describe("the Members page for an Admin", () => {
  // #101-WM-11
  it("shows the roles as text, removes Members only, invites Members only and handles the invitations of Members only", async () => {
    const user = userEvent.setup();
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
    await user.click(within(invite).getByRole("combobox", { name: "Role" }));
    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["Member"]);
    await user.keyboard("{Escape}");
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

describe("the Invitations card", () => {
  // #177-T02
  it("shows the empty state at the card while no invitation waits", () => {
    renderFor("owner", "owner-1", { ...DATA, invitations: [] });

    const card = screen.getByRole("region", { name: "Invitations" });
    expect(within(card).getByText("No invitations waiting.")).toBeTruthy();
    expect(within(card).queryByRole("list")).toBeNull();
  });

  // #177-T03
  it("reaches the role help with the keyboard, announces it and closes it on Escape", async () => {
    const user = userEvent.setup();
    render(
      <InviteForm workspaceSlug="acme" viewerRole="owner" api={fakeApi()} />,
    );

    await user.tab(); // the email address
    await user.tab(); // the role help
    const hint = screen.getByRole("button", { name: "About the roles" });
    expect(document.activeElement).toBe(hint);

    await waitFor(() =>
      expect(hint.getAttribute("aria-describedby")).toBeTruthy(),
    );
    const describedBy = hint.getAttribute("aria-describedby")!;
    expect(document.getElementById(describedBy)?.textContent).toContain(
      "Uses the workspace",
    );

    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(hint.getAttribute("aria-describedby")).toBeNull(),
    );
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

  it("says a refusal in a sentence and sends the focus back to the address", async () => {
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
    expect(document.activeElement).toBe(screen.getByLabelText("Email address"));
  });

  // #177 (review of #215: the refusal describes the address it is about)
  it("ties a refusal to the address with aria-describedby", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    vi.mocked(api.invite).mockResolvedValue({
      ok: false,
      status: 422,
      code: "email_not_allowed",
      issues: [],
    });
    renderFor("owner", "owner-1", DATA, api);

    expect(
      screen.getByLabelText("Email address").getAttribute("aria-describedby"),
    ).toBeNull();

    await user.type(screen.getByLabelText("Email address"), "x@y.test");
    await user.click(screen.getByRole("button", { name: "Send invitation" }));

    const alert = await screen.findByRole("alert");
    expect(alert.id).not.toBe("");
    expect(
      screen.getByLabelText("Email address").getAttribute("aria-describedby"),
    ).toBe(alert.id);
  });

  it("offers to send an invitation again only when the instance can send mail", () => {
    renderFor("owner", "owner-1");
    expect(screen.queryByRole("button", { name: /again$/ })).toBeNull();
    cleanup();

    renderFor("owner", "owner-1", { ...DATA, mailConfigured: true });

    expect(screen.getAllByRole("button", { name: /again$/ })).toHaveLength(2);
  });
});

describe("the avatar of a member", () => {
  function rowOf(userId: string): HTMLElement {
    const row = document.querySelector<HTMLElement>(
      `[data-member="${userId}"]`,
    );
    if (row === null) throw new Error(`no row for ${userId}`);
    return row;
  }

  // #638-T01
  it("is the GitHub avatar of a member with a GitHub account, and the initials of the name otherwise", () => {
    renderFor("member", "member-1", {
      ...DATA,
      members: [
        {
          ...member("owner-1", "owner", "Anna Keller"),
          githubAccountId: "4711",
        },
        member("member-1", "member", "Mira Vogel"),
      ],
    });

    const image = rowOf("owner-1").querySelector("img");
    expect(image?.getAttribute("src")).toBe(
      "https://avatars.githubusercontent.com/u/4711?v=4",
    );
    expect(image?.getAttribute("alt")).toBe("");
    expect(rowOf("member-1").querySelector("img")).toBeNull();
    expect(rowOf("member-1").textContent).toContain("MV");
  });

  // #638-T01
  it("falls back to the initials when the GitHub avatar cannot be loaded", () => {
    renderFor("member", "member-1", {
      ...DATA,
      members: [
        {
          ...member("owner-1", "owner", "Anna Keller"),
          githubAccountId: "4711",
        },
      ],
    });

    fireEvent.error(rowOf("owner-1").querySelector("img")!);

    expect(rowOf("owner-1").querySelector("img")).toBeNull();
    expect(rowOf("owner-1").textContent).toContain("AK");
  });

  // #638-T03
  it("loads no picture from any host other than GitHub's avatar host", () => {
    renderFor("owner", "owner-1", {
      ...DATA,
      members: [
        { ...member("owner-1", "owner"), githubAccountId: "1" },
        { ...member("admin-1", "admin"), githubAccountId: "../../evil.test" },
        member("member-1", "member"),
      ],
    });

    const sources = Array.from(document.querySelectorAll("img")).map(
      (image) => new URL(image.getAttribute("src") ?? "").host,
    );
    expect(sources).toEqual(["avatars.githubusercontent.com"]);
  });
});
