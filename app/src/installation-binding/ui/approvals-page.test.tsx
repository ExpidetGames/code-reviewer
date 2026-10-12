// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the Approvals page of the admin portal: each request that waits shows who asked, the account the
// installation is on and the evidence (whether the person's token lists the installation, and the result of the
// role read), the buttons call the decision, a refusal is told in words, and what the people typed is text.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigation.refresh }),
}));

import type { ApprovalsApi } from "./api.ts";
import { ApprovalsPageContent } from "./approvals-page.tsx";
import type { InstallationLinkRequestView } from "../requests.ts";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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

describe("a request that waits", () => {
  // #103-IB-23
  it("shows who asked, the account of the installation, whether their token can use it, and the result of the role read", () => {
    render(
      <ApprovalsPageContent pending={[request()]} decided={[]} api={api()} />,
    );

    expect(evidenceOf("Asked by")).toBe(
      "Ada Lovelace (ada@example.test), GitHub account ada",
    );
    expect(evidenceOf("For workspace")).toBe("Team A");
    expect(evidenceOf("Installation on")).toBe("acme (organization)");
    expect(evidenceOf("Can their token use the installation?")).toBe("Yes");
    expect(evidenceOf("Their role in the account")).toMatch(
      /^Could not be read \(GitHub refused: the app probably lacks the organization permission Members\)$/,
    );
  });

  // #103-IB-23
  it("says that the token was not checked when the app could not ask for it", () => {
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

    expect(evidenceOf("Can their token use the installation?")).toBe(
      "Not checked",
    );
    expect(evidenceOf("Their role in the account")).toMatch(/Was not asked/);
    expect(evidenceOf("Asked by")).toBe("Ada Lovelace (ada@example.test)");
  });

  // #103-IB-23
  it("says so for a person who is gone and an account that is personal", () => {
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

    expect(evidenceOf("Asked by")).toBe("A user who is gone");
    expect(evidenceOf("Installation on")).toBe("acme (personal account)");
  });

  // #103-IB-20
  it("calls the decision with the button that was pressed and reloads the page", async () => {
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
  it("tells in words why a decision was refused", async () => {
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

    expect((await screen.findByRole("alert")).textContent).toMatch(
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
  // #103-IB-20
  it("says that nothing waits and lists the decisions made", () => {
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
        ]}
        api={api()}
      />,
    );

    expect(screen.getByText("No request waits for a decision.")).toBeTruthy();
    const list = screen.getByRole("list", { name: "Decided requests" });
    const items = within(list).getAllByRole("listitem");
    expect(items[0]?.textContent).toMatch(/acme.*Approved/);
    expect(items[1]?.textContent).toMatch(
      /beta.*Denied by the admin of the instance/,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});
