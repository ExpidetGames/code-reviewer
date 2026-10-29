// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins the GitHub App page (#182): the status card shows the App facts and the addresses directly, and
// the admin's own GitHub account block is gone (it lives on /account).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GithubConfigView } from "../service.ts";
import { GithubSection, GithubStatusCard } from "./github-section.tsx";
import { CODE_REVIEW_COM } from "../../product-identity/code-review-com.ts";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

afterEach(cleanup);

const URLS = {
  homepage: "https://cr.test/",
  webhook: "https://cr.test/api/webhooks/github-app",
  callback: "https://cr.test/api/auth/callback/github",
  setup: "https://cr.test/github/result",
};

function view(overrides: Partial<GithubConfigView> = {}): GithubConfigView {
  return {
    status: "not_configured",
    source: "none",
    app: null,
    problem: null,
    secrets: {
      privateKey: "none",
      webhookSecret: "none",
      clientSecret: "none",
    },
    userAuthorization: { configured: false, clientId: null },
    urls: URLS,
    privateAppUnknown: false,
    mayLackPermissions: false,
    updatedAt: null,
    ...overrides,
  };
}

describe("the GitHub App status card", () => {
  // #182-T03
  it("shows the App addresses directly, without a disclosure", () => {
    const { container } = render(
      <GithubStatusCard
        view={view({
          status: "configured",
          source: "database",
          app: {
            appId: "424242",
            slug: "code-reviewer-e2e",
            privateApp: true,
            origin: "manifest",
            installUrl: null,
          },
          userAuthorization: { configured: true, clientId: "Iv1.x" },
        })}
      />,
    );

    expect(screen.getByText(URLS.webhook)).toBeTruthy();
    expect(screen.getByText(URLS.callback)).toBeTruthy();
    expect(container.querySelector("details")).toBeNull();
    // The card title is an h2, so the page goes h1 -> h2 -> h3 (#182 review).
    expect(
      screen.getByRole("heading", { level: 2, name: "Status" }),
    ).toBeTruthy();
  });

  // #185 (#182 lead note): every address is copyable.
  it("offers a copy button for every address", () => {
    render(
      <GithubStatusCard
        view={view({
          status: "configured",
          source: "database",
          app: {
            appId: "424242",
            slug: "code-reviewer-e2e",
            privateApp: true,
            origin: "manifest",
            installUrl: null,
          },
          userAuthorization: { configured: true, clientId: "Iv1.x" },
        })}
      />,
    );

    expect(
      screen
        .getAllByRole("button", { name: /^Copy the / })
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "Copy the Homepage URL",
      "Copy the Webhook URL",
      "Copy the Callback URL",
      "Copy the Setup URL",
    ]);
  });
});

describe("the GitHub App page", () => {
  // #182-T04
  it("no longer renders the admin's own GitHub account block", () => {
    render(
      <GithubSection
        product={CODE_REVIEW_COM}
        view={view()}
        tenancy="single"
        suggestedName="code-reviewer"
        conflicts={[]}
        outcome={{ ok: null, error: null }}
      />,
    );

    expect(screen.queryByText("Your GitHub account")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Link GitHub account" }),
    ).toBeNull();
  });

  // #182-T01 (the page is h1 -> h2 -> h3, one h1)
  it("renders one h1 and the card titles as h2", () => {
    render(
      <GithubSection
        product={CODE_REVIEW_COM}
        view={view()}
        tenancy="single"
        suggestedName="code-reviewer"
        conflicts={[]}
        outcome={{ ok: null, error: null }}
      />,
    );

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(
      screen.getByRole("heading", { level: 2, name: "Status" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 2, name: "Connect the App" }),
    ).toBeTruthy();
  });
});
