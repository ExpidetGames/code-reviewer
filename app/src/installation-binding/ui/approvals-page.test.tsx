// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the Approvals page of the admin portal: the three tabs (Waiting, Decided, Not linked)
// filter the requests, the page header carries "Sync from GitHub" as its action, each waiting request
// shows who asked, the account the installation is on and the evidence (whether the person's token
// lists the installation, and the result of the role read) behind a disclosure, the buttons call the
// decision, a refusal is told in words, and what the people typed is text.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  refresh: vi.fn(),
  replace: vi.fn(),
  pathname: "/admin/approvals",
  search: "",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: navigation.refresh,
    replace: navigation.replace,
  }),
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

import type { ApprovalsApi } from "./api.ts";
import { ApprovalsPageContent } from "./approvals-page.tsx";
import type { UnclaimedInstallation } from "../../db/repositories/unclaimed-installations-repository.ts";
import type { InstallationLinkRequestView } from "../requests.ts";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  navigation.search = "";
});

function request(
  overrides: Partial<InstallationLinkRequestView> = {},
): InstallationLinkRequestView {
  return {
    id: "r1",
    workspaceId: "w1",
    workspaceName: "Team A",
    workspaceSlug: "team-a",
    requestedBy: "u1",
    requesterName: "Ada Lovelace",
    requesterEmail: "ada@example.test",
    requesterGithubLogin: "ada",
    installationId: "4242",
    accountLogin: "acme",
    accountType: "Organization",
    accountId: "5001",
    status: "pending",
    evidence: {
      tokenCanAccess: true,
      roleResult: "unreadable",
      roleDetail: "forbidden",
    },
    createdAt: "2026-10-12T10:00:00.000Z",
    decidedAt: null,
    decidedBy: null,
    ...overrides,
  };
}

function unclaimed(
  overrides: Partial<UnclaimedInstallation> = {},
): UnclaimedInstallation {
  return {
    installationId: "4242",
    accountLogin: "octo",
    accountType: "Organization",
    firstSeenAt: "2026-10-12T09:00:00.000Z",
    lastSeenAt: "2026-10-12T10:00:00.000Z",
    source: "webhook",
    ...overrides,
  };
}

function api(overrides: Partial<ApprovalsApi> = {}): ApprovalsApi {
  return {
    decide: vi.fn(async () => ({
      ok: true as const,
      data: { ok: true as const },
    })),
    ...overrides,
  };
}

function evidenceOf(label: string): string {
  const term = screen.getByText(label);
  return term.nextElementSibling?.textContent ?? "";
}

/** The variant of the status badge that carries this text. */
function badgeVariant(text: string): string | null {
  const badge = screen.getByText(text).closest("[data-slot='badge']");
  return badge?.getAttribute("data-variant") ?? null;
}

async function openEvidence(
  user: ReturnType<typeof userEvent.setup>,
  accountLogin: string,
): Promise<void> {
  await user.click(
    screen.getByRole("button", { name: `Evidence for ${accountLogin}` }),
  );
}

describe("the tabs of the page", () => {
  // #183-T01
  it("shows only the requests that wait on the Waiting tab", () => {
    render(
      <ApprovalsPageContent
        pending={[request({ accountLogin: "acme" })]}
        decided={[
          request({ id: "r2", status: "approved", accountLogin: "beta" }),
        ]}
        unclaimed={[unclaimed()]}
        api={api()}
      />,
    );

    expect(
      screen
        .getByRole("tab", { name: "Waiting (1)" })
        .getAttribute("data-state"),
    ).toBe("active");
    expect(screen.getByText("acme")).toBeTruthy();
    expect(screen.queryByText("beta")).toBeNull();
    expect(
      screen.queryByRole("list", { name: "Installations nobody has linked" }),
    ).toBeNull();
  });

  // #183-T01
  it("shows only the decisions made on the Decided tab", () => {
    navigation.search = "?tab=decided";
    render(
      <ApprovalsPageContent
        pending={[request({ accountLogin: "acme" })]}
        decided={[
          request({ id: "r2", status: "approved", accountLogin: "beta" }),
        ]}
        unclaimed={[unclaimed()]}
        api={api()}
      />,
    );

    expect(
      screen.getByRole("tab", { name: "Decided" }).getAttribute("data-state"),
    ).toBe("active");
    expect(screen.getByRole("list", { name: "Decided requests" })).toBeTruthy();
    expect(screen.getByText("beta")).toBeTruthy();
    expect(screen.queryByText("acme")).toBeNull();
  });

  // #183-T01
  it("shows only the installations nobody linked on the Not linked tab", () => {
    navigation.search = "?tab=not-linked";
    render(
      <ApprovalsPageContent
        pending={[request({ accountLogin: "acme" })]}
        decided={[]}
        unclaimed={[unclaimed()]}
        api={api()}
      />,
    );

    expect(
      screen
        .getByRole("tab", { name: "Not linked" })
        .getAttribute("data-state"),
    ).toBe("active");
    expect(
      screen.getByRole("list", { name: "Installations nobody has linked" }),
    ).toBeTruthy();
    expect(screen.getByText("octo")).toBeTruthy();
    expect(screen.queryByText("acme")).toBeNull();
  });
});

describe("the page header", () => {
  // #183-T02
  it("renders the one h1, the Admin / Approvals trail and Sync from GitHub as the header action", () => {
    render(
      <ApprovalsPageContent
        pending={[]}
        decided={[]}
        unclaimed={[]}
        api={api()}
      />,
    );

    const header = screen
      .getByRole("heading", { level: 1, name: "Approvals" })
      .closest("header");
    expect(header).not.toBeNull();
    const page = header as HTMLElement;

    expect(
      within(page).getByRole("button", { name: "Sync from GitHub" }),
    ).toBeTruthy();

    const crumb = within(page).getByRole("navigation", { name: "breadcrumb" });
    expect(
      within(crumb).getByRole("link", { name: "Admin" }).getAttribute("href"),
    ).toBe("/admin");
    expect(
      within(crumb)
        .getByRole("link", { name: "Approvals" })
        .getAttribute("aria-current"),
    ).toBe("page");
    // The page has exactly one h1.
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });
});

describe("a request that waits", () => {
  // #183-T03
  it("keeps the evidence behind a disclosure, closed at first", async () => {
    const user = userEvent.setup();
    render(
      <ApprovalsPageContent pending={[request()]} decided={[]} api={api()} />,
    );

    const trigger = screen.getByRole("button", { name: "Evidence for acme" });
    const controls = trigger.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    const content = document.getElementById(controls as string);
    expect(content?.hasAttribute("hidden")).toBe(true);

    await user.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(content?.hasAttribute("hidden")).toBe(false);
  });

  // #103-IB-23
  it("shows who asked, the account of the installation, whether their token can use it, and the result of the role read", async () => {
    const user = userEvent.setup();
    render(
      <ApprovalsPageContent pending={[request()]} decided={[]} api={api()} />,
    );

    await openEvidence(user, "acme");

    expect(evidenceOf("Asked by")).toBe(
      "Ada Lovelace (ada@example.test), GitHub account ada",
    );
    expect(evidenceOf("For workspace")).toBe("Team A");
    expect(evidenceOf("Installation on")).toBe("acme (organization)");
    expect(evidenceOf("Can their token use the installation?")).toMatch(
      /^Yes \(outside collaborators can use an installation too/,
    );
    expect(evidenceOf("Their role in the account")).toMatch(
      /^Could not be read \(GitHub refused: the app probably lacks the organization permission Members\)$/,
    );
  });

  // #103-IB-23
  it("says that the token was not checked when the app could not ask for it", async () => {
    const user = userEvent.setup();
    render(
      <ApprovalsPageContent
        pending={[
          request({
            requesterGithubLogin: null,
            evidence: {
              tokenCanAccess: null,
              roleResult: "unavailable",
              roleDetail: "user_authorization_not_configured",
            },
          }),
        ]}
        decided={[]}
        api={api()}
      />,
    );

    await openEvidence(user, "acme");

    expect(evidenceOf("Can their token use the installation?")).toBe(
      "Not checked",
    );
    expect(evidenceOf("Their role in the account")).toMatch(/Was not asked/);
    expect(evidenceOf("Asked by")).toBe("Ada Lovelace (ada@example.test)");
  });

  // #103-IB-23
  it("says so for a person who is gone and an account that is personal", async () => {
    const user = userEvent.setup();
    render(
      <ApprovalsPageContent
        pending={[
          request({
            requesterName: null,
            requesterEmail: null,
            requesterGithubLogin: null,
            accountType: "User",
          }),
        ]}
        decided={[]}
        api={api()}
      />,
    );

    await openEvidence(user, "acme");

    expect(evidenceOf("Asked by")).toBe("A user who is gone");
    expect(evidenceOf("Installation on")).toBe("acme (personal account)");
  });

  // #183-T04, #103-IB-20
  it("still calls the decision with the button that was pressed and reloads the page", async () => {
    const user = userEvent.setup();
    const calls = api();
    render(
      <ApprovalsPageContent pending={[request()]} decided={[]} api={calls} />,
    );

    await user.click(screen.getByRole("button", { name: "Approve acme" }));
    await user.click(screen.getByRole("button", { name: "Deny acme" }));

    expect(calls.decide).toHaveBeenNthCalledWith(1, "r1", "approve");
    expect(calls.decide).toHaveBeenNthCalledWith(2, "r1", "deny");
    expect(navigation.refresh).toHaveBeenCalledTimes(2);
  });

  // #103-IB-20
  it("tells in words why a decision was refused, as a polite status", async () => {
    const user = userEvent.setup();
    render(
      <ApprovalsPageContent
        pending={[request()]}
        decided={[]}
        api={api({
          decide: vi.fn(async () => ({
            ok: false as const,
            status: 409,
            code: "installation_already_linked",
            issues: [],
          })),
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Approve acme" }));

    const row = screen.getByRole("list", {
      name: "Requests waiting for a decision",
    });
    expect((await within(row).findByRole("status")).textContent).toMatch(
      /connected to a workspace already/,
    );
  });

  // #103-IB-23
  it("renders what people typed as text, never as markup", () => {
    const hostile = '<script>alert("x")</script>';
    render(
      <ApprovalsPageContent
        pending={[request({ requesterName: hostile, workspaceName: hostile })]}
        decided={[]}
        api={api()}
      />,
    );

    expect(
      screen.getAllByText(new RegExp('alert\\("x"\\)')).length,
    ).toBeGreaterThan(0);
    expect(document.querySelector("script")).toBeNull();
  });
});

describe("the page without requests", () => {
  // #103-IB-20, #183-T01
  it("says that nothing waits and lists the decisions made on the Decided tab", () => {
    navigation.search = "?tab=decided";
    render(
      <ApprovalsPageContent
        pending={[]}
        decided={[
          request({
            id: "r2",
            status: "approved",
            decidedAt: "2026-10-12T12:00:00.000Z",
          }),
          request({
            id: "r3",
            status: "denied",
            accountLogin: "beta",
            decidedAt: "2026-10-12T11:00:00.000Z",
          }),
          request({
            id: "r4",
            status: "withdrawn",
            accountLogin: "gamma",
            decidedAt: "2026-10-12T10:30:00.000Z",
          }),
        ]}
        api={api()}
      />,
    );

    const list = screen.getByRole("list", { name: "Decided requests" });
    const items = within(list).getAllByRole("listitem");
    expect(items[0]?.textContent).toMatch(/acme.*Approved/);
    expect(items[1]?.textContent).toMatch(
      /beta.*Denied by a code-review.com admin/,
    );
    expect(screen.queryByRole("button", { name: /Approve|Deny/ })).toBeNull();
    // #183 review: one quiet variant per decision, never the primary fill; the label stays the
    // meaning, so the status is not told by color alone.
    expect(badgeVariant("Approved")).toBe("success");
    expect(badgeVariant("Denied by a code-review.com admin")).toBe("warning");
    expect(badgeVariant("Connected in the meantime")).toBe("neutral");
  });

  // #183-T01
  it("shows an empty state on the Waiting tab while nothing waits", () => {
    render(<ApprovalsPageContent pending={[]} decided={[]} api={api()} />);

    expect(screen.getByText("No requests waiting")).toBeTruthy();
    expect(
      screen.getByText(/appears here when GitHub cannot check who/),
    ).toBeTruthy();
  });
});

describe("the installations nobody has linked", () => {
  // #103-IB-11
  it("lists them with their account and when they were first seen, and says that they have no repositories in the app", () => {
    navigation.search = "?tab=not-linked";
    render(
      <ApprovalsPageContent
        pending={[]}
        decided={[]}
        unclaimed={[
          unclaimed({
            installationId: "4242",
            accountLogin: "acme",
            accountType: "Organization",
            firstSeenAt: "2026-10-12T10:00:00.000Z",
            lastSeenAt: "2026-10-12T11:00:00.000Z",
            source: "webhook",
          }),
          unclaimed({
            installationId: "4300",
            accountLogin: "octo",
            accountType: "User",
            firstSeenAt: "2026-10-12T09:00:00.000Z",
            lastSeenAt: "2026-10-12T09:00:00.000Z",
            source: "sync",
          }),
        ]}
        api={api()}
      />,
    );

    const list = screen.getByRole("list", {
      name: "Installations nobody has linked",
    });
    const items = within(list).getAllByRole("listitem");
    expect(items[0]?.textContent).toMatch(
      /acme.*Organization.*2026-10-12 10:00 UTC/,
    );
    expect(items[1]?.textContent).toMatch(/octo.*Personal account/);
    expect(
      screen.getByText(/Reading the installations again from GitHub does not/),
    ).toBeTruthy();
  });

  // #103-IB-11
  it("says so when GitHub lists none, as an empty state on the Not linked tab", () => {
    navigation.search = "?tab=not-linked";
    render(<ApprovalsPageContent pending={[]} decided={[]} api={api()} />);

    expect(
      screen.getByText("GitHub lists no installation that waits."),
    ).toBeTruthy();
  });
});
