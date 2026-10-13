// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins the Integrations index of the admin portal (#182): a directory of status cards, one per service
// (GitHub App, Mail), each with a status badge, one line and the link to the page that owns it.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GithubConfigView } from "../../github-config/service.ts";
import {
  githubIntegrationCard,
  mailIntegrationCard,
  IntegrationsIndex,
} from "./integrations-index.tsx";

afterEach(cleanup);

function githubView(
  overrides: Partial<GithubConfigView> = {},
): GithubConfigView {
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
    urls: {
      homepage: "https://cr.test/",
      webhook: "https://cr.test/api/webhooks/github-app",
      callback: "https://cr.test/api/auth/callback/github",
      setup: "https://cr.test/github/result",
    },
    privateAppUnknown: false,
    mayLackPermissions: false,
    updatedAt: null,
    ...overrides,
  };
}

function cards() {
  return Array.from(document.querySelectorAll('[data-slot="card"]'));
}

describe("the Integrations index", () => {
  // #182-T01
  it("renders one status card per service with the link to its page", () => {
    render(
      <IntegrationsIndex
        cards={[
          githubIntegrationCard(githubView()),
          mailIntegrationCard({
            mailConfigured: false,
            smtp: { value: null, password: "none" },
          }),
        ]}
      />,
    );

    const found = cards();
    expect(found).toHaveLength(2);
    expect(
      found.map(
        (card) =>
          card.querySelector('[data-slot="card-title"]')?.textContent ?? null,
      ),
    ).toEqual(["GitHub App", "Mail"]);
    // The card titles are h2, the page's one h1 comes from the header (#182 review).
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(
      screen.getByRole("heading", { level: 2, name: "GitHub App" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 2, name: "Mail" }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Open GitHub App" })
        .getAttribute("href"),
    ).toBe("/admin/integrations/github");
    expect(
      screen.getByRole("link", { name: "Open Mail" }).getAttribute("href"),
    ).toBe("/admin/mail");
    // Each card carries its status, not a form.
    expect(screen.getAllByText("Not configured")).toHaveLength(2);
    expect(document.querySelector('[data-slot="badge"]')).not.toBeNull();
  });

  // #182-T01
  it("summarises a configured App with its slug", () => {
    const card = githubIntegrationCard(
      githubView({
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
      }),
    );

    expect(card.badge).toEqual({ variant: "success", text: "Configured" });
    expect(card.summary).toContain("code-reviewer-e2e");
  });

  // #182-T01
  it("marks a saved mail server without a usable password as a problem", () => {
    const card = mailIntegrationCard({
      mailConfigured: false,
      smtp: {
        value: { host: "smtp.test", user: "mailer" },
        password: "unreadable",
      },
    });

    expect(card.badge).toEqual({ variant: "warning", text: "Problem" });
    expect(card.summary).toContain("cannot be read");
  });
});
