// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins the overview of the portal (#180): the "Needs attention" region exists only while there is
// something to act on, the "Setup" card shows one compact row per setting (a status icon, the value
// summary a person would see on its own page, and a Configure link), and the notices that need action
// keep their wording. The old "Setting" badge and the page description are gone.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GithubConfigView } from "../../github-config/service.ts";
import type { AdminSettingsView } from "../service.ts";
import { Overview } from "./overview.tsx";
import { getProductIdentity } from "../../product-identity/current.ts";

const PRODUCT = getProductIdentity();

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
    ownKeyTokenCap: { value: 4_000_000, ...never },
    reviewMaxCostCents: { value: 100, ...never },
    dynamicReview: { value: false, ...never },
    planManagementUrl: { value: null, ...never },
    smtp: { value: null, password: "none", ...never },
    operatorLlmKey: { state: "not_configured" },
    operatorLlmKeys: { openrouter: { state: "not_configured" } },
    modelCatalog: {
      diff: { released: 0, hasDefault: false },
      dynamic: { released: 0, hasDefault: false },
    },
    workspaceCount: 1,
    githubConfigured: false,
    mailConfigured: false,
    signUpRuleState: { failClosed: false },
    secrets: [],
    setupCompletedAt: "2026-10-11T08:00:00.000Z",
    ...overrides,
  };
}

function setupRegion(): HTMLElement {
  return screen.getByRole("region", { name: "Setup" });
}

function row(title: string): HTMLElement {
  const element = within(setupRegion())
    .getByText(title, { exact: true })
    .closest("li");
  if (element === null) throw new Error(`No setup row ${title}`);
  return element;
}

function configuredLink(title: string): HTMLElement {
  return within(row(title)).getByRole("link", { name: `Configure ${title}` });
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

function smtpView(
  password: AdminSettingsView["smtp"]["password"],
): AdminSettingsView["smtp"] {
  return {
    value: {
      host: "smtp.example.com",
      port: 587,
      security: "starttls",
      user: "mailer",
      senderAddress: "a@example.com",
      senderName: null,
      allowSelfSigned: false,
      allowPlainTextLogin: false,
    },
    password,
    updatedBy: null,
    updatedAt: "2026-10-12T08:00:00.000Z",
  };
}

describe("the needs attention region", () => {
  // #180-T01
  it("is not there while there is nothing to report", () => {
    render(<Overview product={PRODUCT} settings={view()} />);

    expect(
      screen.queryByRole("region", { name: "Needs attention" }),
    ).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // #180-T01
  it("appears with the sign-up rule that cannot work yet", () => {
    render(
      <Overview
        product={PRODUCT}
        settings={view({
          signUpRule: {
            value: { kind: "domains", entries: ["a.com"] },
            updatedBy: null,
            updatedAt: null,
          },
          signUpRuleState: { failClosed: true },
        })}
      />,
    );

    const attention = screen.getByRole("region", { name: "Needs attention" });
    expect(
      within(attention).getByText("This sign-up rule does not work yet."),
    ).toBeTruthy();
    expect(
      within(attention).getByRole("link", { name: "Sign-in" }),
    ).toBeTruthy();
  });

  it("announces stored credentials that cannot be read, without naming a value", () => {
    render(
      <Overview
        product={PRODUCT}
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

    const attention = screen.getByRole("region", { name: "Needs attention" });
    expect(
      within(attention).getByText("A stored credential cannot be read."),
    ).toBeTruthy();
  });

  // #102-GH-27
  it("tells the admin how many users could not get their GitHub address", () => {
    render(
      <Overview product={PRODUCT} settings={view()} emailConflictCount={2} />,
    );

    const attention = screen.getByRole("region", { name: "Needs attention" });
    expect(
      within(attention).getByText(/2 users could not get their GitHub address/),
    ).toBeTruthy();
  });

  // #180-T01
  it("renders the Needs attention region before the Setup card", () => {
    render(
      <Overview
        product={PRODUCT}
        settings={view({ signUpRuleState: { failClosed: true } })}
      />,
    );

    const attention = screen.getByRole("region", { name: "Needs attention" });
    const setup = screen.getByRole("region", { name: "Setup" });
    expect(
      attention.compareDocumentPosition(setup) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // #180-T01
  it("shows the three attention rows open and no overflow disclosure", () => {
    render(
      <Overview
        product={PRODUCT}
        settings={view({
          signUpRuleState: { failClosed: true },
          secrets: [
            {
              name: "smtp_password",
              state: "undecryptable",
              code: "secret_undecryptable",
              updatedAt: "2026-10-11T08:00:00.000Z",
              updatedBy: null,
            },
          ],
        })}
        emailConflictCount={1}
      />,
    );

    const attention = screen.getByRole("region", { name: "Needs attention" });
    expect(
      attention.querySelectorAll('[data-slot="attention-row"]'),
    ).toHaveLength(3);
    expect(
      within(attention).queryByRole("button", { name: /more notice/ }),
    ).toBeNull();
  });
});

describe("the setup card", () => {
  // #98-AD-03, #180-T02
  it("lists the six settings with the value summary and a Configure link", () => {
    render(<Overview product={PRODUCT} settings={view()} />);

    expect(row("Mail server").textContent).toContain("Not configured");
    expect(configuredLink("Mail server").getAttribute("href")).toBe(
      "/admin/mail",
    );
    expect(row("GitHub").textContent).toContain("Not configured");
    expect(configuredLink("GitHub").getAttribute("href")).toBe(
      "/admin/integrations",
    );
    expect(row("Tenancy").textContent).toContain("Single-tenant");
    expect(configuredLink("Tenancy").getAttribute("href")).toBe(
      "/admin/setup/instance",
    );
    expect(row("Sign-up rule").textContent).toContain("Everyone");
    expect(configuredLink("Sign-up rule").getAttribute("href")).toBe(
      "/admin/setup/sign-up",
    );
    expect(row("Ways to sign in").textContent).toContain("Email");
    expect(configuredLink("Ways to sign in").getAttribute("href")).toBe(
      "/admin/setup/sign-in",
    );
    expect(row("code-review.com LLM keys").textContent).toContain(
      "Not configured",
    );
    expect(
      configuredLink("code-review.com LLM keys").getAttribute("href"),
    ).toBe("/admin/llm");

    for (const title of [
      "Mail server",
      "GitHub",
      "Tenancy",
      "Sign-up rule",
      "Ways to sign in",
      "code-review.com LLM keys",
    ])
      expect(
        within(row(title)).getByRole("link", { name: `Configure ${title}` }),
      ).toBeTruthy();
  });

  // #180-T02
  it("shows what is configured as the value summary", () => {
    render(
      <Overview
        product={PRODUCT}
        settings={view({
          mailConfigured: true,
          githubConfigured: true,
          tenancy: { value: "multi", updatedBy: null, updatedAt: null },
          signUpRule: {
            value: { kind: "domains", entries: ["a.com", "b.com"] },
            updatedBy: null,
            updatedAt: null,
          },
          signInMethods: {
            value: { emailPassword: true, github: true },
            effective: { emailPassword: true, github: true },
            updatedBy: null,
            updatedAt: null,
          },
        })}
        github={githubView()}
      />,
    );

    expect(row("Mail server").textContent).toContain("Configured");
    expect(row("GitHub").textContent).toContain(
      "Configured (code-reviewer-acme)",
    );
    expect(row("GitHub").textContent).toContain(
      "Signing in with GitHub is enabled",
    );
    expect(row("Tenancy").textContent).toContain("Multi-tenant");
    expect(row("Sign-up rule").textContent).toContain("Allowed email domains");
    expect(row("Ways to sign in").textContent).toContain("Email + GitHub");
  });

  // #98-AD-03
  it("states the tenancy with the number of workspaces", () => {
    render(
      <Overview
        product={PRODUCT}
        settings={view({
          tenancy: { value: "multi", updatedBy: null, updatedAt: null },
          workspaceCount: 2,
        })}
      />,
    );

    expect(row("Tenancy").textContent).toContain("Multi-tenant");
    expect(row("Tenancy").textContent).toContain("2 workspaces");
  });

  // #180-T02
  it("says in the sign-up rule row that the rule cannot work yet", () => {
    render(
      <Overview
        product={PRODUCT}
        settings={view({
          signUpRule: {
            value: { kind: "domains", entries: ["a.com"] },
            updatedBy: null,
            updatedAt: null,
          },
          signUpRuleState: { failClosed: true },
        })}
      />,
    );

    expect(row("Sign-up rule").textContent).toContain(
      "This sign-up rule does not work yet.",
    );
  });

  // #102-GH-21
  it("says in the GitHub row that an App without the user authorization cannot sign people in yet", () => {
    render(
      <Overview
        product={PRODUCT}
        settings={view({ githubConfigured: false })}
        github={githubView({
          userAuthorization: { configured: false, clientId: null },
        })}
      />,
    );

    expect(row("GitHub").textContent).toContain("not enabled yet");
  });

  it("names what is wrong with the App's settings, as field names only", () => {
    render(
      <Overview
        product={PRODUCT}
        settings={view()}
        github={githubView({
          status: "problem",
          problem: { kind: "invalid", fields: ["github_app_private_key"] },
        })}
      />,
    );

    expect(row("GitHub").textContent).toContain("github_app_private_key");
  });

  // #100-review-4
  it("says that a saved mail server cannot send because its password cannot be read", () => {
    render(
      <Overview
        product={PRODUCT}
        settings={view({ smtp: smtpView("unreadable"), mailConfigured: false })}
      />,
    );

    expect(row("Mail server").textContent).toContain("password cannot be read");
    expect(configuredLink("Mail server").getAttribute("href")).toBe(
      "/admin/mail",
    );
  });
});

describe("the LLM keys of the instance (#276, #427)", () => {
  const key = (operatorLlmKey: AdminSettingsView["operatorLlmKey"]) =>
    view({ operatorLlmKey, operatorLlmKeys: { openrouter: operatorLlmKey } });

  // #276-T06
  it("is optional: no key is no warning and no attention notice, because only managed workspaces need it", () => {
    render(<Overview product={PRODUCT} settings={view()} />);

    expect(row("code-review.com LLM keys").textContent).toContain("Optional");
    expect(
      within(row("code-review.com LLM keys")).queryByRole("img", {
        hidden: true,
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("region", { name: /needs attention/i }),
    ).toBeNull();
  });

  // #276-T06
  it("says whether a key is configured and its last four characters, never the key", () => {
    render(
      <Overview
        product={PRODUCT}
        settings={key({
          state: "configured",
          lastFour: "wxyz",
          updatedAt: "2026-10-12T08:00:00.000Z",
          updatedBy: null,
        })}
      />,
    );

    const text = row("code-review.com LLM keys").textContent ?? "";
    expect(text).toContain("Configured");
    expect(text).toContain("wxyz");
  });

  // #276-T06
  it("warns about a saved key that cannot be read, in the row and in the attention region", () => {
    render(
      <Overview
        product={PRODUCT}
        settings={{
          ...key({
            state: "unreadable",
            updatedAt: "2026-10-12T08:00:00.000Z",
            updatedBy: null,
          }),
          secrets: [
            {
              name: "operator_llm_key",
              state: "undecryptable",
              code: "secret_undecryptable",
              updatedAt: "2026-10-12T08:00:00.000Z",
              updatedBy: null,
            },
          ],
        }}
      />,
    );

    expect(row("code-review.com LLM keys").textContent).toContain(
      "cannot be read",
    );
    expect(
      screen.getByRole("link", { name: "LLM key" }).getAttribute("href"),
    ).toBe("/admin/llm");
  });
});

describe("the LLM key of each provider on the overview (#427)", () => {
  const CONFIGURED = {
    state: "configured",
    lastFour: "wxyz",
    updatedAt: "2026-10-12T08:00:00.000Z",
    updatedBy: null,
  } as const;
  const UNREADABLE = {
    state: "unreadable",
    updatedAt: "2026-10-12T08:00:00.000Z",
    updatedBy: null,
  } as const;
  const keys = (operatorLlmKeys: AdminSettingsView["operatorLlmKeys"]) =>
    view({ operatorLlmKeys });

  // #427-T08
  it("shows the status of every provider by its name, one after the other", () => {
    render(
      <Overview
        product={PRODUCT}
        settings={keys({
          openrouter: CONFIGURED,
          fakeai: { state: "not_configured" },
        })}
      />,
    );

    const text = row("code-review.com LLM keys").textContent ?? "";
    expect(text).toContain("OpenRouter: Configured (ending in wxyz)");
    expect(text).toContain("fakeai: Not configured");
    expect(text.indexOf("OpenRouter")).toBeLessThan(text.indexOf("fakeai"));
    expect(text).not.toContain("sk-");
  });

  // #427-T08
  it("warns when the key of any one provider cannot be read, and names that provider", () => {
    render(
      <Overview
        product={PRODUCT}
        settings={keys({ openrouter: CONFIGURED, fakeai: UNREADABLE })}
      />,
    );

    const text = row("code-review.com LLM keys").textContent ?? "";
    expect(text).toContain("OpenRouter: Configured");
    expect(text).toContain("fakeai: Saved, cannot be read");
    expect(text).toContain("until its key is entered again");
  });

  // #427-T08
  it("is optional while no provider has a key, and links to the page of the keys", () => {
    render(
      <Overview
        product={PRODUCT}
        settings={keys({
          openrouter: { state: "not_configured" },
          fakeai: { state: "not_configured" },
        })}
      />,
    );

    expect(row("code-review.com LLM keys").textContent).toContain("Optional");
    expect(
      screen.queryByRole("region", { name: /needs attention/i }),
    ).toBeNull();
    expect(
      within(row("code-review.com LLM keys"))
        .getByRole("link")
        .getAttribute("href"),
    ).toBe("/admin/llm");
  });
});

describe("the model catalog (#429)", () => {
  const catalog = (modelCatalog: AdminSettingsView["modelCatalog"]) =>
    view({ modelCatalog });

  // #429-T06
  it("shows how many entries are released for each kind and whether the kind has a default, in place of the tiers", () => {
    render(
      <Overview
        product={PRODUCT}
        settings={catalog({
          diff: { released: 2, hasDefault: true },
          dynamic: { released: 0, hasDefault: false },
        })}
      />,
    );

    const text = row("Model catalog").textContent ?? "";
    expect(text).toContain("Diff: 2 released, default set");
    expect(text).toContain("Dynamic: none released, no default");
    expect(screen.queryByText("Managed model tiers")).toBeNull();
  });

  // #429-T06
  it("shows counts and no name, provider or model: the view has nothing else to show", () => {
    const settings = catalog({
      diff: { released: 1, hasDefault: false },
      dynamic: { released: 1, hasDefault: true },
    });
    render(<Overview product={PRODUCT} settings={settings} />);

    expect(Object.keys(settings.modelCatalog).sort()).toEqual([
      "diff",
      "dynamic",
    ]);
    for (const kind of Object.values(settings.modelCatalog))
      expect(Object.keys(kind).sort()).toEqual(["hasDefault", "released"]);
    expect(row("Model catalog").textContent).not.toMatch(/mce_|\//);
  });

  // #429-T06
  it("links to the LLM page, where the catalog is managed", () => {
    render(<Overview product={PRODUCT} settings={view()} />);

    expect(
      within(row("Model catalog")).getByRole("link").getAttribute("href"),
    ).toBe("/admin/llm");
  });

  // #429-T06
  it("is optional: an empty catalog is no warning and no attention notice", () => {
    render(<Overview product={PRODUCT} settings={view()} />);

    expect(row("Model catalog").textContent).toContain(
      "Diff: none released, no default",
    );
    expect(
      screen.queryByRole("region", { name: /needs attention/i }),
    ).toBeNull();
  });

  // #434-X2
  it("has no row for the managed model tiers any more: a model is a catalog entry", () => {
    render(<Overview product={PRODUCT} settings={view()} />);

    expect(screen.queryByText("Managed model tiers")).toBeNull();
  });
});
