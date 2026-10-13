// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the pages of an account that has no workspace yet or is looking at an invitation: what a person
// without a workspace is told in each kind of instance, the form that creates a workspace, the button that
// accepts an invitation (nothing is accepted by opening a page), and the switcher in the header.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/w/acme/projects" }));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import type { AccountApi } from "./api.ts";
import { AcceptInvitation } from "./accept-invitation.tsx";
import { CreateWorkspaceForm } from "./create-workspace-form.tsx";
import { NoAccessContent } from "./no-access-content.tsx";

afterEach(() => {
  cleanup();
  navigation.pathname = "/w/acme/projects";
});

function accountApi(overrides: Partial<AccountApi> = {}): AccountApi {
  return {
    createWorkspace: vi.fn(async () => ({
      ok: true,
      data: { ok: true, workspace: { slug: "team-a", name: "Team A" } },
    })) as never,
    accept: vi.fn(async () => ({
      ok: true,
      data: {
        ok: true,
        workspace: { slug: "acme", name: "Acme" },
        role: "member",
        alreadyMember: false,
      },
    })) as never,
    ...overrides,
  };
}

describe("a person without a workspace", () => {
  // #101-WM-02
  it("is told to ask an admin for an invitation in a single-tenant instance, and is offered no way to create one", () => {
    render(
      <NoAccessContent
        multiTenant={false}
        pending={[]}
        isInstanceAdmin={false}
      />,
    );

    expect(
      screen.getByText(/Ask an admin of this instance for an invitation/),
    ).toBeTruthy();
    expect(
      screen.queryByRole("form", { name: "Create a workspace" }),
    ).toBeNull();
    expect(
      screen.queryByRole("link", { name: "open the admin portal" }),
    ).toBeNull();
  });

  // #101-WM-01
  it("is offered the creation of a workspace in a multi-tenant instance", () => {
    render(
      <NoAccessContent multiTenant pending={[]} isInstanceAdmin={false} />,
    );

    expect(
      screen.getByRole("form", { name: "Create a workspace" }),
    ).toBeTruthy();
    expect(screen.queryByText(/Ask an admin of this instance/)).toBeNull();
  });

  // #101-WM-21
  it("sees the invitations that wait for them, each with a button that accepts it", async () => {
    const user = userEvent.setup();
    const api = accountApi();
    const open = vi.fn();
    render(
      <NoAccessContent
        multiTenant={false}
        isInstanceAdmin={false}
        pending={[
          {
            id: "inv-1",
            workspaceName: "Acme <script>",
            role: "admin",
            expiresAt: "2026-10-19T08:00:00.000Z",
          },
        ]}
        api={api}
        open={open}
      />,
    );

    expect(screen.getByText("Acme <script>")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Accept/ }));

    expect(api.accept).toHaveBeenCalledWith({ invitationId: "inv-1" });
    await waitFor(() => expect(open).toHaveBeenCalledWith("/w/acme/projects"));
  });

  it("shows the instance admin the way to the portal", () => {
    render(<NoAccessContent multiTenant pending={[]} isInstanceAdmin />);

    expect(
      screen
        .getByRole("link", { name: "open the admin portal" })
        .getAttribute("href"),
    ).toBe("/admin");
  });

  // #171-T04
  it("renders the same card for the action in both instance modes, with at most one primary action", () => {
    const single = render(
      <NoAccessContent
        multiTenant={false}
        pending={[]}
        isInstanceAdmin={false}
      />,
    );
    expect(
      single.container.querySelectorAll('[data-slot="card"]'),
    ).toHaveLength(1);
    expect(
      single.container.querySelectorAll('button[data-variant="default"]'),
    ).toHaveLength(0);
    single.unmount();

    const multi = render(
      <NoAccessContent multiTenant pending={[]} isInstanceAdmin={false} />,
    );
    expect(multi.container.querySelectorAll('[data-slot="card"]')).toHaveLength(
      1,
    );
    expect(
      multi.container.querySelectorAll('button[data-variant="default"]'),
    ).toHaveLength(1);
  });
});

describe("the form that creates a workspace", () => {
  // #101-WM-01
  it("creates it and opens it", async () => {
    const user = userEvent.setup();
    const api = accountApi();
    const open = vi.fn();
    render(<CreateWorkspaceForm api={api} open={open} />);

    await user.type(screen.getByLabelText("Name of the workspace"), "Team A");
    await user.click(
      screen.getByRole("button", { name: "Create the workspace" }),
    );

    expect(api.createWorkspace).toHaveBeenCalledWith("Team A");
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith("/w/team-a/projects"),
    );
  });

  // #101-WM-04
  it("says that the limit is reached in a sentence", async () => {
    const user = userEvent.setup();
    const api = accountApi({
      createWorkspace: vi.fn(async () => ({
        ok: false,
        status: 409,
        code: "workspace_limit_reached",
        issues: [],
      })) as never,
    });
    const open = vi.fn();
    render(<CreateWorkspaceForm api={api} open={open} />);

    await user.type(screen.getByLabelText("Name of the workspace"), "Team A");
    await user.click(
      screen.getByRole("button", { name: "Create the workspace" }),
    );

    expect((await screen.findByRole("alert")).textContent).toBe(
      "You own as many workspaces as this instance allows.",
    );
    expect(open).not.toHaveBeenCalled();
  });
});

describe("accepting an invitation", () => {
  // #101-WM-24
  it("happens by the button, a call with the token from the link, and nothing happens before it is pressed", async () => {
    const user = userEvent.setup();
    const api = accountApi();
    const open = vi.fn();
    render(
      <AcceptInvitation
        which={{ token: "T".repeat(43) }}
        workspaceName="Acme"
        api={api}
        open={open}
      />,
    );
    expect(api.accept).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button"));

    expect(api.accept).toHaveBeenCalledWith({ token: "T".repeat(43) });
    await waitFor(() => expect(open).toHaveBeenCalledWith("/w/acme/projects"));
  });

  it.each([
    ["invitation_used", "This invitation was used already."],
    [
      "email_mismatch",
      "You are signed in with another address than the one this invitation is for.",
    ],
    ["invitation_expired", "This invitation has expired. Ask for a new one."],
  ])("says %s in a sentence", async (code, sentence) => {
    const user = userEvent.setup();
    const api = accountApi({
      accept: vi.fn(async () => ({
        ok: false,
        status: 409,
        code,
        issues: [],
      })) as never,
    });
    render(
      <AcceptInvitation
        which={{ token: "T".repeat(43) }}
        workspaceName="Acme"
        api={api}
        open={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button"));

    expect((await screen.findByRole("alert")).textContent).toBe(sentence);
  });
});
