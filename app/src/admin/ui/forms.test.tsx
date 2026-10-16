// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the setup forms of the portal (#181): the instance form (tenancy and the limit as two
// cards of one form, saving only what changed, running both changes and showing each card's own
// result), the sign-up rule form, and the ways-to-sign-in form. What each one sends, the sentences for
// what the server refuses, the focus the refused field gets (R20), and — #181-T02 — that each form is
// exactly one form whose saved state is inline (no remount key). The rules themselves are the server's
// (src/admin/service.integration.test.ts). The tenancy copy comes from one owner, shared with the
// wizard (#181-T05).
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
import { SignUpSection } from "./sign-up-section.tsx";
import { SignUpRuleForm } from "./sign-up-form.tsx";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigation.refresh }),
}));

afterEach(cleanup);

type Answer = RequestResult<{ ok: true; settings: AdminSettingsView }>;

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
    dynamicReview: { value: false, ...never },
    planManagementUrl: { value: null, ...never },
    smtp: { value: null, password: "none", ...never },
    operatorLlmKey: { state: "not_configured" },
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

function apiAnswering(result: Answer) {
  const change = vi.fn<(change: SettingChange) => Promise<Answer>>(() =>
    Promise.resolve(result),
  );
  const testMail = vi.fn<AdminApi["testMail"]>(() =>
    Promise.resolve({ ok: true, data: { ok: true } } as const),
  );
  return { api: { change, testMail } satisfies AdminApi, change };
}

/** An api whose `change` answers with `results` in order, then repeats the last one. */
function apiSequencing(...results: Answer[]) {
  const change = vi.fn<(change: SettingChange) => Promise<Answer>>();
  for (const result of results) change.mockResolvedValueOnce(result);
  change.mockResolvedValue(results.at(-1) ?? SAVED);
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

function card(name: "Tenancy" | "Limits" | "Dynamic Review"): HTMLElement {
  return screen.getByRole("group", { name });
}

describe("the Dynamic Review card of the instance form", () => {
  // #202 (gate control)
  it("is off by default and says what turning it on does", () => {
    const { api } = apiAnswering(SAVED);
    render(<InstanceForm settings={view()} api={api} />);

    const dynamic = card("Dynamic Review");
    const allow = within(dynamic).getByRole("checkbox", {
      name: /Allow Dynamic Review/,
    });
    expect(allow.getAttribute("aria-checked")).toBe("false");
    expect(dynamic.textContent).toMatch(/runner that can run it/);
    expect(dynamic.textContent).toMatch(/dynamic_review_disabled/);
  });

  // #262-T04
  it("tells an admin to deploy a Dynamic-capable runner, not that the engine has not shipped", () => {
    const { api } = apiAnswering(SAVED);
    render(<InstanceForm settings={view()} api={api} />);

    const text = card("Dynamic Review").textContent;
    expect(text).not.toMatch(/until it ships/i);
    expect(text).not.toMatch(/cannot be activated yet/i);
    expect(text).toMatch(/Deploy a Dynamic-capable runner/);
  });

  // #202 (gate control)
  it("sends the gate only after the rollout order was confirmed, and nothing else", async () => {
    const { api, change } = apiAnswering(SAVED);
    const user = userEvent.setup();
    render(<InstanceForm settings={view()} api={api} />);
    const dynamic = card("Dynamic Review");

    await user.click(
      within(dynamic).getByRole("checkbox", { name: /Allow Dynamic Review/ }),
    );
    await user.click(
      screen.getByRole("button", { name: "Save instance settings" }),
    );

    // Not confirmed: the server is not asked, the card says why.
    expect(change).not.toHaveBeenCalled();
    expect(within(dynamic).getByRole("alert").textContent).toMatch(/Confirm/);

    await user.click(
      within(dynamic).getByRole("checkbox", { name: /every app instance/i }),
    );
    await user.click(
      screen.getByRole("button", { name: "Save instance settings" }),
    );

    await waitFor(() =>
      expect(within(dynamic).getByRole("status").textContent).toBe("Saved."),
    );
    expect(change).toHaveBeenCalledTimes(1);
    expect(change).toHaveBeenCalledWith({ dynamicReview: { enabled: true } });
  });

  // #202 (gate control)
  it("asks for the rollout confirmation again after a successful save", async () => {
    const { api } = apiAnswering(SAVED);
    const user = userEvent.setup();
    render(<InstanceForm settings={view()} api={api} />);
    const dynamic = card("Dynamic Review");

    await user.click(
      within(dynamic).getByRole("checkbox", { name: /Allow Dynamic Review/ }),
    );
    await user.click(
      within(dynamic).getByRole("checkbox", { name: /every app instance/i }),
    );
    await user.click(
      screen.getByRole("button", { name: "Save instance settings" }),
    );
    await waitFor(() =>
      expect(within(dynamic).getByRole("status").textContent).toBe("Saved."),
    );

    // The confirmation belonged to that save: it must not carry over to the next one.
    expect(
      within(dynamic)
        .getByRole("checkbox", { name: /every app instance/i })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  // #202 (gate control)
  it("turns the gate off without a confirmation", async () => {
    const { api, change } = apiAnswering(SAVED);
    const user = userEvent.setup();
    render(
      <InstanceForm
        settings={view({
          dynamicReview: {
            value: true,
            updatedBy: null,
            updatedAt: null,
          },
        })}
        api={api}
      />,
    );
    const dynamic = card("Dynamic Review");
    const allow = within(dynamic).getByRole("checkbox", {
      name: /Allow Dynamic Review/,
    });
    expect(allow.getAttribute("aria-checked")).toBe("true");

    await user.click(allow);
    await user.click(
      screen.getByRole("button", { name: "Save instance settings" }),
    );

    await waitFor(() =>
      expect(change).toHaveBeenCalledWith({
        dynamicReview: { enabled: false },
      }),
    );
  });

  // #202 (gate control)
  it("shows the sentence for a refused change on its own card", async () => {
    const { api } = apiAnswering(refused("unavailable"));
    const user = userEvent.setup();
    render(
      <InstanceForm
        settings={view({
          dynamicReview: { value: true, updatedBy: null, updatedAt: null },
        })}
        api={api}
      />,
    );
    const dynamic = card("Dynamic Review");

    await user.click(
      within(dynamic).getByRole("checkbox", { name: /Allow Dynamic Review/ }),
    );
    await user.click(
      screen.getByRole("button", { name: "Save instance settings" }),
    );

    await waitFor(() =>
      expect(within(dynamic).getByRole("alert").textContent).not.toBe(""),
    );
  });
});

describe("the plan management card of the instance form", () => {
  // #284-T11
  it("says what the page is for, in generic words, and is empty while there is none", () => {
    render(<InstanceForm settings={view()} />);

    const card = screen.getByRole("group", { name: "Plan management page" });
    expect(
      (within(card).getByLabelText("Address of the page") as HTMLInputElement)
        .value,
    ).toBe("");
    expect(card.textContent).toMatch(/operator-configured page/i);
    expect(card.textContent).toMatch(/https/i);
  });

  // #284-T02
  it("sends only the address, and nothing else, when only the address changed", async () => {
    const { api, change } = apiAnswering(SAVED);
    render(<InstanceForm settings={view()} api={api} />);

    await userEvent.type(
      screen.getByLabelText("Address of the page"),
      "https://plans.example/manage",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save instance settings" }),
    );

    await waitFor(() => expect(change).toHaveBeenCalledTimes(1));
    expect(change).toHaveBeenCalledWith({
      planManagementUrl: "https://plans.example/manage",
    });
  });

  // #284-T01
  it("removes the page when the field is emptied", async () => {
    const { api, change } = apiAnswering(SAVED);
    render(
      <InstanceForm
        settings={view({
          planManagementUrl: {
            value: "https://plans.example/manage",
            updatedBy: null,
            updatedAt: null,
          },
        })}
        api={api}
      />,
    );

    await userEvent.clear(screen.getByLabelText("Address of the page"));
    await userEvent.click(
      screen.getByRole("button", { name: "Save instance settings" }),
    );

    await waitFor(() => expect(change).toHaveBeenCalledTimes(1));
    expect(change).toHaveBeenCalledWith({ planManagementUrl: null });
  });

  // #284-T11
  it.each([
    ["url_not_https", /must start with https/i],
    ["url_has_credentials", /user name or password/i],
    ["url_has_fragment", /must not contain a # fragment/i],
    ["url_invalid", /not a valid address/i],
    ["url_too_long", /too long/i],
  ])(
    "shows the reason for %s next to the field and moves focus to it",
    async (code, text) => {
      const { api } = apiAnswering(
        refused("invalid_input", [{ field: "planManagementUrl", code }]),
      );
      render(<InstanceForm settings={view()} api={api} />);

      await userEvent.type(
        screen.getByLabelText("Address of the page"),
        "http://plans.example/",
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Save instance settings" }),
      );

      const field = screen.getByLabelText("Address of the page");
      expect(await screen.findByText(text)).toBeTruthy();
      expect(field.getAttribute("aria-invalid")).toBe("true");
      await waitFor(() => expect(document.activeElement).toBe(field));
    },
  );

  it("does not save the other settings when only the address changed", async () => {
    const { api, change } = apiAnswering(SAVED);
    render(<InstanceForm settings={view()} api={api} />);

    await userEvent.type(
      screen.getByLabelText("Address of the page"),
      "https://plans.example/",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save instance settings" }),
    );

    await waitFor(() => expect(change).toHaveBeenCalled());
    expect(change.mock.calls.map(([sent]) => Object.keys(sent))).toEqual([
      ["planManagementUrl"],
    ]);
  });
});

describe("the instance form", () => {
  // #98-AD-07
  it("sends the chosen tenancy and says on the card that it was saved", async () => {
    const { api, change } = apiAnswering(SAVED);
    const user = userEvent.setup();
    render(<InstanceForm settings={view()} api={api} />);

    await user.click(screen.getByRole("radio", { name: /Multi-tenant/ }));
    await user.click(
      screen.getByRole("button", { name: "Save instance settings" }),
    );

    await waitFor(() =>
      expect(within(card("Tenancy")).getByRole("status").textContent).toBe(
        "Saved.",
      ),
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
    await waitFor(() =>
      expect(within(card("Limits")).getByRole("status").textContent).toBe(
        "Saved.",
      ),
    );
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
      expect(within(card("Tenancy")).getByRole("alert").textContent).toContain(
        "3 workspaces",
      ),
    );
  });

  it("runs the second change and shows both results when the first is refused", async () => {
    const { api, change } = apiSequencing(
      refused("too_many_workspaces"),
      SAVED,
    );
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
    const field = screen.getByLabelText(/Maximum number of workspaces/);
    await user.clear(field);
    await user.type(field, "3");
    await user.click(
      screen.getByRole("button", { name: "Save instance settings" }),
    );

    // The independent limit change is not dropped because the tenancy was refused.
    await waitFor(() => expect(change).toHaveBeenCalledTimes(2));
    expect(change).toHaveBeenNthCalledWith(1, { tenancy: "single" });
    expect(change).toHaveBeenNthCalledWith(2, {
      limits: { maxWorkspacesPerUser: 3 },
    });
    await waitFor(() =>
      expect(within(card("Tenancy")).getByRole("alert").textContent).toContain(
        "3 workspaces",
      ),
    );
    expect(within(card("Limits")).getByRole("status").textContent).toBe(
      "Saved.",
    );
    // The limit was saved, so the page data (and "last changed") is refreshed.
    expect(navigation.refresh).toHaveBeenCalled();
  });

  it("shows the saved card next to the refused one when the second is refused", async () => {
    const { api } = apiSequencing(
      SAVED,
      refused("invalid_input", [
        { field: "maxWorkspacesPerUser", code: "number_out_of_range" },
      ]),
    );
    const user = userEvent.setup();
    render(<InstanceForm settings={view()} api={api} />);

    await user.click(screen.getByRole("radio", { name: /Multi-tenant/ }));
    const field = screen.getByLabelText(/Maximum number of workspaces/);
    await user.clear(field);
    await user.type(field, "abc");
    await user.click(
      screen.getByRole("button", { name: "Save instance settings" }),
    );

    await waitFor(() =>
      expect(within(card("Tenancy")).getByRole("status").textContent).toBe(
        "Saved.",
      ),
    );
    expect(
      within(card("Limits")).getByText(/Enter a whole number/),
    ).toBeTruthy();
    expect(navigation.refresh).toHaveBeenCalled();
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

    expect(screen.getAllByText(/Never changed/)).toHaveLength(4);
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

  // #181-T06 (rulebook R20)
  it("moves focus to the limit field when the limit is refused", async () => {
    const { api } = apiAnswering(
      refused("invalid_input", [
        { field: "maxWorkspacesPerUser", code: "number_out_of_range" },
      ]),
    );
    const user = userEvent.setup();
    render(<InstanceForm settings={view()} api={api} />);
    const field = screen.getByLabelText(/Maximum number of workspaces/);

    await user.clear(field);
    await user.type(field, "abc");
    await user.click(
      screen.getByRole("button", { name: "Save instance settings" }),
    );

    await waitFor(() => expect(document.activeElement).toBe(field));
  });

  // #181-T06 (rulebook R20)
  it("moves focus to the tenancy choice when the tenancy is refused", async () => {
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
      expect(document.activeElement).toBe(
        screen.getByRole("radio", { name: /Single-tenant/ }),
      ),
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

  // #181-T06 (rulebook R20)
  it("moves focus to the entries when the server refuses them", async () => {
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
    const entries = screen.getByLabelText("Email addresses");
    await user.type(entries, "not an email");
    await user.click(screen.getByRole("button", { name: "Save sign-up rule" }));

    await waitFor(() => expect(document.activeElement).toBe(entries));
  });
});

describe("the sign-up page body", () => {
  // #181: the negative case of the fail-closed notice (the old "and not otherwise").
  it("shows the fail-closed notice only while the rule cannot work yet", () => {
    const closed = render(
      <SignUpSection
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
    expect(
      screen.getByRole("region", { name: "Needs attention" }).textContent,
    ).toContain("does not work yet");
    closed.unmount();

    render(<SignUpSection settings={view()} />);
    expect(
      screen.queryByRole("region", { name: "Needs attention" }),
    ).toBeNull();
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

  // #181: the wrapper is a real 44px target, a `<label for>` like the project toggle.
  it("wraps each switch in a label associated with it", () => {
    render(<SignInMethodsForm settings={view({ githubConfigured: true })} />);

    for (const name of [/Email with password/, /GitHub/]) {
      const control = screen.getByRole("switch", { name });
      const wrapper = control.closest("label");
      expect(wrapper).not.toBeNull();
      expect(wrapper?.getAttribute("for")).toBe(control.id);
      expect(wrapper?.className).toContain("min-h-11");
    }
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

  // #181-T06 (rulebook R20)
  it("moves focus to the GitHub switch when that way is refused", async () => {
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
      expect(document.activeElement).toBe(
        screen.getByRole("switch", { name: /GitHub/ }),
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
      expect(within(card("Tenancy")).getByRole("alert").textContent).toContain(
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
      { key: "instance", element: <InstanceForm settings={view()} /> },
      { key: "sign-up", element: <SignUpRuleForm settings={view()} /> },
      {
        key: "sign-in",
        element: <SignInMethodsForm settings={view()} />,
      },
    ];
    for (const { key, element } of renders) {
      const { container, unmount } = render(<div key={key}>{element}</div>);
      expect(container.querySelectorAll("form")).toHaveLength(1);
      // Every form owns at least one inline live region; the instance form has one per card.
      expect(
        container.querySelectorAll("form [role='status']").length,
      ).toBeGreaterThanOrEqual(1);
      unmount();
    }

    // A save keeps what was chosen (the form is not remounted) and shows "Saved." inline.
    const { api } = apiAnswering(SAVED);
    render(<InstanceForm settings={view()} api={api} />);
    await user.click(screen.getByRole("radio", { name: /Multi-tenant/ }));
    await user.click(
      screen.getByRole("button", { name: "Save instance settings" }),
    );
    await waitFor(() =>
      expect(within(card("Tenancy")).getByRole("status").textContent).toBe(
        "Saved.",
      ),
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
