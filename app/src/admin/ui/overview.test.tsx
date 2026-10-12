// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the overview of the portal: the checklist shows what is configured and what is not, the
// notice for a sign-up rule that cannot work yet is there exactly when the state says so, and stored
// credentials that cannot be read are announced.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GithubConfigView } from "../../github-config/service.ts";
import type { AdminSettingsView } from "../service.ts";
import { Overview } from "./overview.tsx";

afterEach(cleanup);

function view(overrides: Partial<AdminSettingsView> = {}): AdminSettingsView {
  const never = { updatedBy: null, updatedAt: null };
  return {
    tenancy: { value: "single", ...never },
    signUpRule: { value: { kind: "everyone" }, ...never },
    signInMethods: {
      value: { emailPassword: true, github: false },
      effective: { emailPassword: true, github: false },
      ...never,
    },
    maxWorkspacesPerUser: { value: 10, ...never },
    smtp: { value: null, password: "none", ...never },
    workspaceCount: 1,
    githubConfigured: false,
    mailConfigured: false,
    signUpRuleState: { failClosed: false },
    secrets: [],
    setupCompletedAt: "2026-10-11T08:00:00.000Z",
    ...overrides,
  };
}

function item(title: string): HTMLElement {
  const element = screen.getByText(title).closest("li");
  if (element === null) throw new Error(`No checklist item ${title}`);
  return element;
}

function githubView(changes: Partial<GithubConfigView> = {}): GithubConfigView {
  return {
    status: "configured",
    source: "database",
    app: {
      appId: "424242",
      slug: "code-reviewer-acme",
      privateApp: true,
      origin: "manifest",
      installUrl:
        "https://github.com/apps/code-reviewer-acme/installations/new",
    },
    problem: null,
    secrets: {
      privateKey: "configured",
      webhookSecret: "configured",
      clientSecret: "configured",
    },
    userAuthorization: { configured: true, clientId: "Iv1.0123456789abcdef" },
    urls: {
      homepage: "https://reviews.example.test",
      webhook: "https://reviews.example.test/api/webhooks/github-app",
      callback: "https://reviews.example.test/api/auth/callback/github",
      setup: "https://reviews.example.test/github/connected",
    },
    privateAppUnknown: false,
    mayLackPermissions: false,
    updatedAt: "2026-10-12T08:00:00.000Z",
    ...changes,
  };
}

describe("the checklist", () => {
  // #98-AD-03
  it("lists the mail server, GitHub, the tenancy, the sign-up rule and the ways to sign in", () => {
    render(<Overview settings={view()} />);

    for (const title of [
      "Mail server",
      "GitHub",
      "Tenancy",
      "Sign-up rule",
      "Ways to sign in",
    ])
      expect(item(title)).toBeTruthy();
  });

  // #98-AD-03
  it("marks the mail server and GitHub as to do while they are not configured, with a link to the section", () => {
    render(<Overview settings={view()} />);

    expect(within(item("Mail server")).getByText("To do")).toBeTruthy();
    expect(
      within(item("Mail server"))
        .getByRole("link", { name: "Mail" })
        .getAttribute("href"),
    ).toBe("/admin/mail");
    expect(within(item("GitHub")).getByText("To do")).toBeTruthy();
    expect(
      within(item("GitHub"))
        .getByRole("link", { name: "Integrations" })
        .getAttribute("href"),
    ).toBe("/admin/integrations");
  });

  it("marks them as done once they are configured", () => {
    render(
      <Overview
        settings={view({ mailConfigured: true, githubConfigured: true })}
        github={githubView()}
      />,
    );

    expect(within(item("Mail server")).getByText("Done")).toBeTruthy();
    expect(within(item("GitHub")).getByText("Done")).toBeTruthy();
    expect(within(item("GitHub")).getByText(/code-reviewer-acme/)).toBeTruthy();
    expect(
      within(item("GitHub")).getByText(/Signing in with GitHub is enabled/),
    ).toBeTruthy();
  });

  // #102-GH-21
  it("says that an App without the user authorization cannot sign people in yet", () => {
    render(
      <Overview
        settings={view({ githubConfigured: false })}
        github={githubView({
          userAuthorization: { configured: false, clientId: null },
        })}
      />,
    );

    expect(within(item("GitHub")).getByText("Done")).toBeTruthy();
    expect(within(item("GitHub")).getByText(/not enabled yet/)).toBeTruthy();
  });

  it("names what is wrong with the App's settings, as field names only", () => {
    render(
      <Overview
        settings={view()}
        github={githubView({
          status: "problem",
          problem: { kind: "invalid", fields: ["github_app_private_key"] },
        })}
      />,
    );

    expect(within(item("GitHub")).getByText("To do")).toBeTruthy();
    expect(
      within(item("GitHub")).getByText(/github_app_private_key/),
    ).toBeTruthy();
  });

  // #102-GH-27
  it("tells the admin how many users could not get their GitHub address", () => {
    render(<Overview settings={view()} emailConflictCount={2} />);

    expect(
      screen.getByText(/2 users could not get their GitHub address/),
    ).toBeTruthy();
  });

  // #100-review-4
  it("says that a saved mail server cannot send because its password cannot be read, and what that stops", () => {
    const smtp = {
      value: {
        host: "smtp.example.com",
        port: 587,
        security: "starttls" as const,
        user: "mailer",
        senderAddress: "a@example.com",
        senderName: null,
        allowSelfSigned: false,
        allowPlainTextLogin: false,
      },
      password: "unreadable" as const,
      updatedBy: null,
      updatedAt: "2026-10-12T08:00:00.000Z",
    };
    render(<Overview settings={view({ smtp, mailConfigured: false })} />);

    const mail = item("Mail server");
    expect(within(mail).getByText("To do")).toBeTruthy();
    expect(mail.textContent).toContain("password cannot be read");
    expect(mail.textContent).toContain("nothing that needs mail is offered");
    expect(
      within(mail).getByRole("link", { name: "Mail" }).getAttribute("href"),
    ).toBe("/admin/mail");
  });

  // #98-AD-03
  it("states the tenancy with the number of workspaces and the sign-up rule in words", () => {
    render(
      <Overview
        settings={view({
          tenancy: { value: "multi", updatedBy: null, updatedAt: null },
          workspaceCount: 2,
          signUpRule: {
            value: { kind: "domains", entries: ["a.com", "b.com", "c.com"] },
            updatedBy: null,
            updatedAt: null,
          },
        })}
      />,
    );

    expect(item("Tenancy").textContent).toContain("Multi-tenant");
    expect(item("Tenancy").textContent).toContain("2 workspaces");
    expect(item("Sign-up rule").textContent).toContain(
      "Only 3 listed domains.",
    );
  });
});

describe("the notices", () => {
  // #97-SU-19
  // #99-SR-22
  it("warns that the sign-up rule cannot work yet exactly when the state says so", () => {
    const closed = render(
      <Overview settings={view({ signUpRuleState: { failClosed: true } })} />,
    );
    expect(screen.getByRole("note").textContent).toContain("does not work yet");
    closed.unmount();

    render(
      <Overview settings={view({ signUpRuleState: { failClosed: false } })} />,
    );

    expect(screen.queryByRole("note")).toBeNull();
  });

  it("announces stored credentials that cannot be read, without naming a value", () => {
    render(
      <Overview
        settings={view({
          secrets: [
            {
              name: "smtp_password",
              state: "undecryptable",
              code: "secret_undecryptable",
              updatedAt: "2026-10-11T08:00:00.000Z",
              updatedBy: null,
            },
            { name: "github_app_private_key", state: "not_configured" },
          ],
        })}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "A stored credential cannot be read.",
    );
  });

  it("shows no alert when every stored credential can be read", () => {
    render(<Overview settings={view()} />);

    expect(screen.queryByRole("alert")).toBeNull();
  });
});
