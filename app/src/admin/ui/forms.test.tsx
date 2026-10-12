// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the forms of the admin pages: what each one sends, the sentences for what the server
// refuses, and the notice for a sign-up rule that cannot work yet. The rules themselves are the server's
// (src/admin/service.integration.test.ts); these tests only prove that the forms ask for the right thing
// and say the reasons.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestResult } from "../../ui/json-request.ts";
import type { AdminSettingsView } from "../service.ts";
import type { AdminApi, SettingChange } from "./api.ts";
import { LimitsForm } from "./limits-form.tsx";
import { SignInMethodsForm } from "./sign-in-form.tsx";
import { SignUpRuleForm } from "./sign-up-form.tsx";
import { TenancyForm } from "./tenancy-form.tsx";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigation.refresh }),
}));

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

function apiAnswering(
  result: RequestResult<{ ok: true; settings: AdminSettingsView }>,
) {
  const change = vi.fn<(change: SettingChange) => Promise<typeof result>>(() =>
    Promise.resolve(result),
  );
  const testMail = vi.fn<AdminApi["testMail"]>(() =>
    Promise.resolve({ ok: true, data: { ok: true } } as const),
  );
  return { api: { change, testMail } satisfies AdminApi, change };
}

const SAVED = { ok: true, data: { ok: true, settings: view() } } as const;
const refused = (
  code: string,
  issues: Array<{ field: string; code: string }> = [],
) => ({ ok: false, status: 409, code, issues }) as const;

describe("the tenancy form", () => {
  // #98-AD-07
  it("sends the chosen tenancy and says it was saved", async () => {
    const { api, change } = apiAnswering(SAVED);
    const user = userEvent.setup();
    render(<TenancyForm settings={view()} api={api} />);

    await user.click(screen.getByRole("radio", { name: /Multi-tenant/ }));
    await user.click(screen.getByRole("button", { name: "Save tenancy" }));

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Saved."),
    );
    expect(change).toHaveBeenCalledWith({ tenancy: "multi" });
    expect(navigation.refresh).toHaveBeenCalled();
  });

  // #98-AD-06
  it("says how many workspaces stand in the way when the change to single-tenant is refused", async () => {
    const { api } = apiAnswering(refused("too_many_workspaces"));
    const user = userEvent.setup();
    render(
      <TenancyForm
        settings={view({
          tenancy: { value: "multi", updatedBy: null, updatedAt: null },
          workspaceCount: 3,
        })}
        api={api}
      />,
    );

    await user.click(screen.getByRole("radio", { name: /Single-tenant/ }));
    await user.click(screen.getByRole("button", { name: "Save tenancy" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("3 workspaces"),
    );
  });

  // #98-AD-14
  it("shows who changed the tenancy last and when", () => {
    render(
      <TenancyForm
        settings={view({
          tenancy: {
            value: "multi",
            updatedBy: { id: "u1", email: "ada@example.com" },
            updatedAt: "2026-10-11T09:00:00.000Z",
          },
        })}
      />,
    );

    expect(
      screen.getByText(
        "Last changed by ada@example.com on 2026-10-11 09:00 UTC.",
      ),
    ).toBeTruthy();
  });

  it("says that a setting was never changed", () => {
    render(<TenancyForm settings={view()} />);

    expect(screen.getByText(/Never changed/)).toBeTruthy();
  });
});

describe("the sign-up rule form", () => {
  it("sends the entries as a list, split at lines, commas and spaces", async () => {
    const { api, change } = apiAnswering(SAVED);
    const user = userEvent.setup();
    render(<SignUpRuleForm settings={view()} api={api} />);

    await user.click(
      screen.getByRole("radio", { name: /Allowed email domains/ }),
    );
    await user.type(
      screen.getByLabelText("Domains"),
      "example.com, other.org{Enter}third.net",
    );
    await user.click(screen.getByRole("button", { name: "Save sign-up rule" }));

    await waitFor(() => expect(change).toHaveBeenCalled());
    expect(change).toHaveBeenCalledWith({
      signUp: {
        kind: "domains",
        entries: ["example.com", "other.org", "third.net"],
      },
    });
  });

  it("sends the rule everyone without entries", async () => {
    const { api, change } = apiAnswering(SAVED);
    const user = userEvent.setup();
    render(
      <SignUpRuleForm
        settings={view({
          signUpRule: {
            value: { kind: "emails", entries: ["a@example.com"] },
            updatedBy: null,
            updatedAt: null,
          },
        })}
        api={api}
      />,
    );

    await user.click(screen.getByRole("radio", { name: /Everyone/ }));
    await user.click(screen.getByRole("button", { name: "Save sign-up rule" }));

    await waitFor(() => expect(change).toHaveBeenCalled());
    expect(change).toHaveBeenCalledWith({ signUp: { kind: "everyone" } });
  });

  it("shows the reason next to the entries when the server refuses them", async () => {
    const { api } = apiAnswering({
      ok: false,
      status: 422,
      code: "invalid_input",
      issues: [{ field: "signUp.entries", code: "entry_invalid" }],
    });
    const user = userEvent.setup();
    render(<SignUpRuleForm settings={view()} api={api} />);

    await user.click(
      screen.getByRole("radio", { name: /A list of email addresses/ }),
    );
    await user.type(screen.getByLabelText("Email addresses"), "not an email");
    await user.click(screen.getByRole("button", { name: "Save sign-up rule" }));

    await waitFor(() =>
      expect(screen.getByText(/One of the entries is not valid/)).toBeTruthy(),
    );
    expect(
      screen.getByLabelText("Email addresses").getAttribute("aria-invalid"),
    ).toBe("true");
  });

  // #97-SU-19
  // #99-SR-22
  it("shows the notice while the rule cannot work yet, and not otherwise", () => {
    const rule: AdminSettingsView["signUpRule"] = {
      value: { kind: "domains", entries: ["example.com"] },
      updatedBy: null,
      updatedAt: null,
    };
    const closed = render(
      <SignUpRuleForm
        settings={view({
          signUpRule: rule,
          signUpRuleState: { failClosed: true },
        })}
      />,
    );
    expect(screen.getByRole("note").textContent).toContain("does not work yet");
    closed.unmount();

    render(
      <SignUpRuleForm
        settings={view({
          signUpRule: rule,
          signUpRuleState: { failClosed: false },
        })}
      />,
    );

    expect(screen.queryByRole("note")).toBeNull();
  });
});

describe("the form of the ways to sign in", () => {
  // #98-AD-09
  it("cannot switch GitHub on while it is not configured, and says why", () => {
    render(<SignInMethodsForm settings={view({ githubConfigured: false })} />);

    const github = screen.getByRole("checkbox", { name: /GitHub/ });
    expect((github as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/set up the GitHub App/)).toBeTruthy();
  });

  // #98-SIGN-IN-METHODS
  it("says that switching a way off does not end the sessions that exist", () => {
    render(<SignInMethodsForm settings={view()} />);

    expect(screen.getByText(/does not sign anybody out/)).toBeTruthy();
  });

  it("sends the two switches", async () => {
    const { api, change } = apiAnswering(SAVED);
    const user = userEvent.setup();
    render(
      <SignInMethodsForm
        settings={view({
          githubConfigured: true,
          signInMethods: {
            value: { emailPassword: true, github: true },
            effective: { emailPassword: true, github: true },
            updatedBy: null,
            updatedAt: null,
          },
        })}
        api={api}
      />,
    );

    await user.click(
      screen.getByRole("checkbox", { name: /Email with password/ }),
    );
    await user.click(
      screen.getByRole("button", { name: "Save ways to sign in" }),
    );

    await waitFor(() => expect(change).toHaveBeenCalled());
    expect(change).toHaveBeenCalledWith({
      signInMethods: { emailPassword: false, github: true },
    });
  });

  // #98-AD-16
  it("tells the admin to link their own GitHub account when GitHub only is refused", async () => {
    const { api } = apiAnswering(refused("admin_needs_github_identity"));
    const user = userEvent.setup();
    render(
      <SignInMethodsForm
        settings={view({ githubConfigured: true })}
        api={api}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Save ways to sign in" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "link your own GitHub account",
      ),
    );
  });
});

describe("the limits form", () => {
  it("sends the number and shows the default", async () => {
    const { api, change } = apiAnswering(SAVED);
    const user = userEvent.setup();
    render(<LimitsForm settings={view()} api={api} />);
    const field = screen.getByLabelText(/Maximum number of workspaces/);
    expect((field as HTMLInputElement).value).toBe("10");

    await user.clear(field);
    await user.type(field, "3");
    await user.click(screen.getByRole("button", { name: "Save limit" }));

    await waitFor(() => expect(change).toHaveBeenCalled());
    expect(change).toHaveBeenCalledWith({
      limits: { maxWorkspacesPerUser: 3 },
    });
  });

  it("shows the server's reason for a number that is not allowed", async () => {
    const { api } = apiAnswering({
      ok: false,
      status: 422,
      code: "invalid_input",
      issues: [{ field: "maxWorkspacesPerUser", code: "number_out_of_range" }],
    });
    const user = userEvent.setup();
    render(<LimitsForm settings={view()} api={api} />);
    const field = screen.getByLabelText(/Maximum number of workspaces/);

    await user.clear(field);
    await user.type(field, "abc");
    await user.click(screen.getByRole("button", { name: "Save limit" }));

    await waitFor(() =>
      expect(
        screen.getByText("Enter a whole number from 1 to 1000."),
      ).toBeTruthy(),
    );
  });
});

describe("a failure that is not about a field", () => {
  it("is described in a sentence, also when the server could not be reached", async () => {
    const { api } = apiAnswering({
      ok: false,
      status: null,
      code: "NETWORK_ERROR",
      issues: [],
    });
    const user = userEvent.setup();
    render(<TenancyForm settings={view()} api={api} />);

    await user.click(screen.getByRole("button", { name: "Save tenancy" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "could not be reached",
      ),
    );
  });
});
