// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins the GitHub App page (#182): the status card shows the App facts and the addresses directly, and
// the admin's own GitHub account block is gone (it lives on /account).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GithubConfigView } from "../service.ts";
import { GithubSection, GithubStatusCard } from "./github-section.tsx";

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
  });
});

describe("the GitHub App page", () => {
  // #182-T04
  it("no longer renders the admin's own GitHub account block", () => {
    render(
      <GithubSection
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
});
