// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the setup forms of the portal (#181): the instance form (tenancy and the limit as two
// cards of one form, saving only what changed), the sign-up rule form, and the ways-to-sign-in form.
// What each one sends, the sentences for what the server refuses, and — #181-T02 — that each form is
// exactly one form whose saved state is inline (no remount key). The rules themselves are the server's
// (src/admin/service.integration.test.ts); these tests only prove that the forms ask for the right
// thing and say the reasons. The tenancy copy comes from one owner, shared with the wizard (#181-T05).
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TENANCY_OPTIONS } from "../../signup/ui/tenancy-copy.ts";
import { Wizard } from "../../setup/ui/wizard.tsx";
import type { RequestResult } from "../../ui/json-request.ts";
import type { AdminSettingsView } from "../service.ts";
import type { AdminApi, SettingChange } from "./api.ts";
import { InstanceForm } from "./instance-form.tsx";
import { SignInMethodsForm } from "./sign-in-form.tsx";
import { SignUpRuleForm } from "./sign-up-form.tsx";

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
    importNotice: null,
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

describe("the instance form", () => {
  // #98-AD-07
  it("sends the chosen tenancy and says it was saved", async () => {
    const { api, change } = apiAnswering(SAVED);
    const user = userEvent.setup();
    render(<InstanceForm settings={view()} api={api} />);

    await user.click(screen.getByRole("radio", { name: /Multi-tenant/ }));
    await user.click(
      screen.getByRole("button", { name: "Save instance settings" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Saved."),
    );
    expect(change).toHaveBeenCalledWith({ tenancy: "multi" });
    expect(navigation.refresh).toHaveBeenCalled();
  });

  it("sends only the limit when only the limit changed", async () => {
    const { api, change } = apiAnswering(SAVED);
    const user = userEvent.setup();
    render(<InstanceForm settings={view()} api={api} />);
    const field = screen.getByLabelText(/Maximum number of workspaces/);
    expect((field as HTMLInputElement).value).toBe("10");

    await user.clear(field);
    await user.type(field, "3");
    await user.click(
      screen.getByRole("button", { name: "Save instance settings" }),
    );

    await waitFor(() => expect(change).toHaveBeenCalled());
    expect(change).toHaveBeenCalledWith({
      limits: { maxWorkspacesPerUser: 3 },
    });
    expect(change).toHaveBeenCalledTimes(1);
  });

  // #98-AD-06
  it("says how many workspaces stand in the way when the change to single-tenant is refused", async () => {
    const { api } = apiAnswering(refused("too_many_workspaces"));
    const user = userEvent.setup();
    render(
      <InstanceForm
        settings={view({
          tenancy: { value: "multi", updatedBy: null, updatedAt: null },
          workspaceCount: 3,
        })}
        api={api}
      />,
    );

    await user.click(screen.getByRole("radio", { name: /Single-tenant/ }));
    await user.click(
      screen.getByRole("button", { name: "Save instance settings" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("3 workspaces"),
    );
  });

  // #98-AD-14
  it("shows who changed the tenancy last and when", () => {
    render(
      <InstanceForm
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
    render(<InstanceForm settings={view()} />);

    expect(screen.getAllByText(/Never changed/)).toHaveLength(2);
  });

  it("shows the server's reason for a number that is not allowed", async () => {
    const { api } = apiAnswering({
      ok: false,
      status: 422,
      code: "invalid_input",
      issues: [{ field: "maxWorkspacesPerUser", code: "number_out_of_range" }],
    });
    const user = userEvent.setup();
    render(<InstanceForm settings={view()} api={api} />);
    const field = screen.getByLabelText(/Maximum number of workspaces/);

    await user.clear(field);
    await user.type(field, "abc");
    await user.click(
      screen.getByRole("button", { name: "Save instance settings" }),
    );

    await waitFor(() =>
      expect(
        screen.getByText("Enter a whole number from 1 to 1000."),
      ).toBeTruthy(),
    );
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
});

describe("the form of the ways to sign in", () => {
  // #98-AD-09
  it("cannot switch GitHub on while it is not configured, and says why", () => {
    render(<SignInMethodsForm settings={view({ githubConfigured: false })} />);

    const github = screen.getByRole("switch", { name: /GitHub/ });
    expect((github as HTMLButtonElement).disabled).toBe(true);
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
      screen.getByRole("switch", { name: /Email with password/ }),
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

describe("a failure that is not about a field", () => {
  it("is described in a sentence, also when the server could not be reached", async () => {
    const { api } = apiAnswering({
      ok: false,
      status: null,
      code: "NETWORK_ERROR",
      issues: [],
    });
    const user = userEvent.setup();
    render(<InstanceForm settings={view()} api={api} />);

    await user.click(screen.getByRole("radio", { name: /Multi-tenant/ }));
    await user.click(
      screen.getByRole("button", { name: "Save instance settings" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "could not be reached",
      ),
    );
  });
});

describe("the shape of the setup forms", () => {
  // #181-T02
  it("renders every setup form as exactly one form with the saved state inline, not via a remount key", async () => {
    const user = userEvent.setup();
    const renders = [
      <InstanceForm key="instance" settings={view()} />,
      <SignUpRuleForm key="sign-up" settings={view()} />,
      <SignInMethodsForm key="sign-in" settings={view()} />,
    ];
    for (const element of renders) {
      const { container, unmount } = render(element);
      expect(container.querySelectorAll("form")).toHaveLength(1);
      // The saved state is one inline status inside the form, not a remount of the form.
      expect(
        within(container.querySelector("form") as HTMLElement).getAllByRole(
          "status",
        ),
      ).toHaveLength(1);
      unmount();
    }

    // A save keeps what was chosen (the form is not remounted) and shows "Saved." next to the button.
    const { api } = apiAnswering(SAVED);
    render(<InstanceForm settings={view()} api={api} />);
    await user.click(screen.getByRole("radio", { name: /Multi-tenant/ }));
    await user.click(
      screen.getByRole("button", { name: "Save instance settings" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Saved."),
    );
    expect(
      (
        screen.getByRole("radio", { name: /Multi-tenant/ }) as HTMLElement
      ).getAttribute("aria-checked"),
    ).toBe("true");
  });
});

describe("the shared tenancy copy", () => {
  // #181-T05
  it("is rendered identically by the first-run wizard and the instance form, from one owner", () => {
    const wizard = render(
      <Wizard
        api={{ submitCode: vi.fn(), complete: vi.fn() }}
        onDone={vi.fn()}
      />,
    );
    for (const option of TENANCY_OPTIONS) {
      expect(screen.getByText(option.title)).toBeTruthy();
      expect(screen.getByText(option.text)).toBeTruthy();
    }
    wizard.unmount();

    render(<InstanceForm settings={view()} />);
    for (const option of TENANCY_OPTIONS) {
      expect(screen.getByText(option.title)).toBeTruthy();
      expect(screen.getByText(option.text)).toBeTruthy();
    }
  });
});
