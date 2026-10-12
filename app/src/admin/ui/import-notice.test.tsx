// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// The notice that the import of an existing installation leaves on the overview (#180): one line of
// summary with the details behind a disclosure, the details in words (variables, never values), and the
// admin can hide it.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImportNotice as Notice } from "../../legacy-import/notice.ts";
import type { AdminApi, SettingChange } from "./api.ts";
import { ImportNotice } from "./import-notice.tsx";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigation.refresh }),
}));

afterEach(cleanup);

const NOTICE: Notice = {
  createdAt: "2026-10-12T08:00:00.000Z",
  dismissedAt: null,
  memberCount: 2,
  notMembers: [
    { login: "dave", reason: "not_allowed" },
    { login: "erin", reason: "login_bound_to_another_account" },
    { login: "frank", reason: "check_failed" },
  ],
  notMembersTotal: 5,
  neverSignedIn: ["gina", "hank"],
  neverSignedInTotal: 2,
  organization: "acme",
  notImported: [
    {
      group: "github_app",
      problem: "invalid",
      variables: ["GITHUB_APP_PRIVATE_KEY"],
    },
  ],
  oauthApp: true,
  invalidLoginEntries: 1,
};

function api() {
  const change = vi.fn<
    (change: SettingChange) => ReturnType<AdminApi["change"]>
  >(() =>
    Promise.resolve({ ok: true, data: { ok: true, settings: {} as never } }),
  );
  return {
    change,
    api: { change, testMail: vi.fn() } satisfies AdminApi,
  };
}

describe("the notice of the import", () => {
  // #106-IM-07
  it("lists who was not made a member and why, the logins that never signed in, and says the organization is not migrated", () => {
    const { container } = render(
      <ImportNotice notice={NOTICE} api={api().api} />,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("dave");
    expect(text).toContain("was not on the list");
    expect(text).toContain("erin");
    expect(text).toContain("belongs to another GitHub account");
    expect(text).toContain("frank");
    expect(text).toContain("could not be checked");
    expect(text).toContain("and 2 more");
    expect(text).toContain("gina, hank");
    expect(text).toContain("Invite them by email");
    expect(text).toMatch(/organization is not migrated/);
    expect(text).toContain("acme");
    expect(text).toMatch(/email list or as allowed domains/);
    expect(text).toContain("2 people are a member");
  });

  // #106-IM-14
  it("names the variable that could not be imported and the OAuth app that is no longer used", () => {
    const { container } = render(
      <ImportNotice notice={NOTICE} api={api().api} />,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("The GitHub App was not imported");
    expect(text).toContain("GITHUB_APP_PRIVATE_KEY");
    expect(text).toContain("GITHUB_OAUTH_CLIENT_SECRET");
    expect(text).toContain("1 entries");
  });

  it("leaves out what there is nothing to say about", () => {
    const { container } = render(
      <ImportNotice
        notice={{
          ...NOTICE,
          notMembers: [],
          notMembersTotal: 0,
          neverSignedIn: [],
          neverSignedInTotal: 0,
          organization: null,
          notImported: [],
          oauthApp: false,
          invalidLoginEntries: 0,
          memberCount: 1,
        }}
        api={api().api}
      />,
    );

    expect(container.querySelectorAll("li")).toHaveLength(0);
    expect(container.textContent).toContain("1 person is a member");
  });

  // #180-T03
  it("shows one line of summary with the details behind a disclosure", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ImportNotice notice={NOTICE} api={api().api} />,
    );

    expect(container.textContent).toContain(
      "imported into the default workspace",
    );
    const trigger = screen.getByRole("button", { name: "Details" });
    const content = document.getElementById(
      trigger.getAttribute("aria-controls")!,
    );
    expect(content?.hasAttribute("hidden")).toBe(true);
    expect(content?.textContent).toContain("dave");

    await user.click(trigger);

    expect(content?.hasAttribute("hidden")).toBe(false);
  });

  // #106-IM-07
  it("is hidden by the admin with one call", async () => {
    const answer = api();
    render(<ImportNotice notice={NOTICE} api={answer.api} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Hide this notice" }),
    );

    await waitFor(() =>
      expect(answer.change).toHaveBeenCalledWith({
        importNotice: { dismiss: true },
      }),
    );
    await waitFor(() => expect(navigation.refresh).toHaveBeenCalled());
  });
});
