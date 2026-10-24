// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the wizard: three steps in order, each step one named form with the heading outside it
// and a visible step count, the choices are kept while going back and forth, the fail-closed hint
// and the password rule each fit one line with the long text in a hint, and the problems the server
// reports are shown at the field and take the person to its step.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PASSWORD_RULE_HINT } from "../../auth/password-policy.ts";
import { FAIL_CLOSED_WARNING } from "../../signup/ui/rule-copy.ts";
import type { SetupApi } from "./api.ts";
import { FAIL_CLOSED_LINE, PASSWORD_REASON } from "./messages.ts";
import { splitEntries, Wizard } from "./wizard.tsx";

afterEach(cleanup);

function radio(name: RegExp): HTMLElement {
  return screen.getByRole("radio", { name });
}

function isChecked(name: RegExp): boolean {
  return radio(name).getAttribute("aria-checked") === "true";
}

/** Opens the InfoHint of that name and returns its text; the trigger opens on hover/focus (#167). */
async function hintText(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
): Promise<string> {
  const trigger = screen.getByRole("button", { name });
  await user.hover(trigger);
  await waitFor(() =>
    expect(trigger.getAttribute("aria-describedby")).toBeTruthy(),
  );
  const describedBy = trigger.getAttribute("aria-describedby") as string;
  return document.getElementById(describedBy)?.textContent ?? "";
}

function renderWizard(
  result: Awaited<ReturnType<SetupApi["complete"]>> = {
    ok: true,
    data: { ok: true, redirectTo: "/admin" },
  },
) {
  const complete = vi.fn<SetupApi["complete"]>(async () => result);
  const onDone = vi.fn();
  render(<Wizard api={{ submitCode: vi.fn(), complete }} onDone={onDone} />);
  return { complete, onDone, user: userEvent.setup() };
}

async function toStep3(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Next" }));
  await user.click(screen.getByRole("button", { name: "Next" }));
}

async function fillAdmin(
  user: ReturnType<typeof userEvent.setup>,
  password = "x7Kq-m2Vd9Lw",
  repeat = password,
) {
  await user.type(screen.getByLabelText("Email address"), "admin@example.com");
  await user.type(screen.getByLabelText("Password"), password);
  await user.type(screen.getByLabelText("Repeat the password"), repeat);
}

describe("the wizard of an update from before accounts", () => {
  // #106-IM-07
  it("preselects a list of email addresses, says the old list is not carried over, and keeps every rule selectable", async () => {
    const user = userEvent.setup();
    render(
      <Wizard
        existingInstallation
        api={{ submitCode: vi.fn(), complete: vi.fn() }}
        onDone={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(isChecked(/A list of email addresses/)).toBe(true);
    expect(isChecked(/Everyone/)).toBe(false);
    expect(screen.getByText(/are not carried over as a rule/)).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: /Everyone/ }));
    expect(isChecked(/Everyone/)).toBe(true);
    await user.click(
      screen.getByRole("radio", { name: /Allowed email domains/ }),
    );
    expect(screen.getByLabelText("Domains")).toBeTruthy();
  });

  // #106-IM-07
  it("needs addresses for the preselected rule before it goes on", async () => {
    const user = userEvent.setup();
    render(
      <Wizard
        existingInstallation
        api={{ submitCode: vi.fn(), complete: vi.fn() }}
        onDone={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Next" }));

    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByRole("heading").textContent).toMatch(/Who may sign up/);
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  // #106-IM-07
  it("is not what a new instance gets: that starts on everyone, without the sentence", async () => {
    const user = userEvent.setup();
    render(
      <Wizard
        api={{ submitCode: vi.fn(), complete: vi.fn() }}
        onDone={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(isChecked(/Everyone/)).toBe(true);
    expect(screen.queryByText(/not carried over/)).toBeNull();
  });
});

describe("the wizard", () => {
  it("asks the three questions in order", async () => {
    const { user } = renderWizard();

    expect(screen.getByRole("heading").textContent).toMatch(
      /How will it be used/,
    );
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading").textContent).toMatch(/Who may sign up/);
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading").textContent).toMatch(/admin account/);
    expect(screen.getByText("Step 3 of 3")).toBeTruthy();
  });

  // #97-SU-11
  it("sends the choices as single-tenant and everyone by default", async () => {
    const { user, complete, onDone } = renderWizard();
    await toStep3(user);
    await fillAdmin(user);

    await user.click(screen.getByRole("button", { name: "Finish setup" }));

    expect(complete).toHaveBeenCalledWith({
      tenancy: "single",
      signUp: { kind: "everyone" },
      admin: { email: "admin@example.com", password: "x7Kq-m2Vd9Lw" },
    });
    expect(onDone).toHaveBeenCalledWith("/admin");
  });

  // #97-SU-12
  it("sends multi-tenant when it was chosen, and keeps the choice when going back", async () => {
    const { user, complete } = renderWizard();
    await user.click(screen.getByRole("radio", { name: /Multi-tenant/ }));
    await toStep3(user);
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(isChecked(/Multi-tenant/)).toBe(true);
    await toStep3(user);
    await fillAdmin(user);

    await user.click(screen.getByRole("button", { name: "Finish setup" }));

    expect(complete.mock.calls[0]?.[0].tenancy).toBe("multi");
  });

  // #97-SU-19
  it("sends the entries of an email list or domain rule and shows the fail-closed hint next to them", async () => {
    const { user, complete } = renderWizard();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.queryByText(/nobody except you can sign up/)).toBeNull();

    await user.click(
      screen.getByRole("radio", { name: /list of email addresses/i }),
    );
    expect(screen.getByText(/nobody except you can sign up/)).toBeTruthy();
    // The longer shared warning is behind the hint, so the line stays one sentence (#172-T04).
    expect(
      await hintText(user, "Why this rule cannot verify anyone yet"),
    ).toMatch(/mail server or GitHub/);
    await user.type(
      screen.getByLabelText("Email addresses"),
      "anna@example.com, bob@example.org",
    );
    await user.click(screen.getByRole("button", { name: "Next" }));
    await fillAdmin(user);
    await user.click(screen.getByRole("button", { name: "Finish setup" }));

    expect(complete.mock.calls[0]?.[0].signUp).toEqual({
      kind: "emails",
      entries: ["anna@example.com", "bob@example.org"],
    });
  });

  it("does not leave step 2 with an empty list", async () => {
    const { user } = renderWizard();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(
      screen.getByRole("radio", { name: /Allowed email domains/ }),
    );

    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByRole("alert").textContent).toMatch(
      /at least one entry/i,
    );
    expect(screen.getByRole("heading").textContent).toMatch(/Who may sign up/);
  });

  // #97-SU-10
  it("shows the password rule and its reason before anything is sent", async () => {
    const { user } = renderWizard();
    await toStep3(user);

    expect(
      screen.getByText(/At least 12 and at most 128 characters/),
    ).toBeTruthy();
    expect(screen.getByText(/not a common password/)).toBeTruthy();
  });

  it("does not send two passwords that differ", async () => {
    const { user, complete } = renderWizard();
    await toStep3(user);
    await fillAdmin(user, "x7Kq-m2Vd9Lw", "x7Kq-m2Vd9Lx");

    await user.click(screen.getByRole("button", { name: "Finish setup" }));

    expect(complete).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/not the same/);
  });

  // #97-SU-10
  it("shows the reason the server gives for the password, next to the field", async () => {
    const { user } = renderWizard({
      ok: false,
      status: 422,
      code: "invalid_input",
      issues: [{ field: "admin.password", code: "password_too_common" }],
    });
    await toStep3(user);
    await fillAdmin(user, "password1234");

    await user.click(screen.getByRole("button", { name: "Finish setup" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /too common/,
    );
  });

  it("goes back to the step of a problem the server reports for an earlier field", async () => {
    const { user } = renderWizard({
      ok: false,
      status: 422,
      code: "invalid_input",
      issues: [{ field: "signUp.entries", code: "entry_invalid" }],
    });
    await toStep3(user);
    await fillAdmin(user);

    await user.click(screen.getByRole("button", { name: "Finish setup" }));

    expect((await screen.findByRole("heading")).textContent).toMatch(
      /Who may sign up/,
    );
  });

  // #97-SU-09
  it("says to restart the app when the setup session has ended", async () => {
    const { user, onDone } = renderWizard({
      ok: false,
      status: 401,
      code: "setup_session_expired",
      issues: [],
    });
    await toStep3(user);
    await fillAdmin(user);

    await user.click(screen.getByRole("button", { name: "Finish setup" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Restart the app/,
    );
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe("the shape of the steps", () => {
  // #172-T02
  it("renders every step as exactly one form named by its heading, which sits outside it", async () => {
    const { user } = renderWizard();

    const firstHeading = screen.getByRole("heading", {
      level: 1,
      name: "How will it be used?",
    });
    const firstForm = screen.getByRole("form", {
      name: "How will it be used?",
    });
    expect(firstForm.contains(firstHeading)).toBe(false);
    expect(screen.getAllByRole("form")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Next" }));

    const secondHeading = screen.getByRole("heading", {
      level: 1,
      name: "Who may sign up?",
    });
    const secondForm = screen.getByRole("form", { name: "Who may sign up?" });
    expect(secondForm.contains(secondHeading)).toBe(false);
    expect(screen.getAllByRole("form")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Next" }));

    const thirdHeading = screen.getByRole("heading", {
      level: 1,
      name: "Create the admin account",
    });
    const thirdForm = screen.getByRole("form", {
      name: "Create the admin account",
    });
    expect(thirdForm.contains(thirdHeading)).toBe(false);
    expect(screen.getAllByRole("form")).toHaveLength(1);
  });

  // #172-T03
  it("shows the step count as text and on the progress element", async () => {
    const { user } = renderWizard();

    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "33",
    );

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Step 2 of 3")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "67",
    );

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Step 3 of 3")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "100",
    );
  });

  // #172-T04
  it("shows the fail-closed warning as one line with the long text in a hint", async () => {
    const { user } = renderWizard();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(
      screen.getByRole("radio", { name: /list of email addresses/i }),
    );

    expect(screen.getByText(FAIL_CLOSED_LINE)).toBeTruthy();
    expect(screen.queryByText(FAIL_CLOSED_WARNING)).toBeNull();

    expect(
      await hintText(user, "Why this rule cannot verify anyone yet"),
    ).toContain(FAIL_CLOSED_WARNING);
  });

  // #172-T04
  it("shows the password rule as one line with the reason in a hint", async () => {
    const { user } = renderWizard();
    await toStep3(user);

    expect(screen.getByText(PASSWORD_RULE_HINT)).toBeTruthy();
    expect(screen.queryByText(PASSWORD_REASON)).toBeNull();

    expect(await hintText(user, "What makes a good password")).toContain(
      PASSWORD_REASON,
    );
  });

  // #172-T04 (rulebook R20)
  it("moves focus to the field the server refuses", async () => {
    const { user } = renderWizard({
      ok: false,
      status: 422,
      code: "invalid_input",
      issues: [{ field: "admin.password", code: "password_too_common" }],
    });
    await toStep3(user);
    await fillAdmin(user, "password1234");

    await user.click(screen.getByRole("button", { name: "Finish setup" }));

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Password")),
    );
  });

  // #172-T04 (rulebook R20)
  it("moves focus to a field of an earlier step it goes back to", async () => {
    const { user } = renderWizard({
      ok: false,
      status: 422,
      code: "invalid_input",
      issues: [{ field: "signUp.entries", code: "entry_invalid" }],
    });
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(
      screen.getByRole("radio", { name: /list of email addresses/i }),
    );
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.type(
      screen.getByLabelText("Email addresses"),
      "anna@example.com",
    );
    await user.click(screen.getByRole("button", { name: "Next" }));
    await fillAdmin(user);

    await user.click(screen.getByRole("button", { name: "Finish setup" }));

    expect(
      screen.getByRole("heading", { level: 1, name: "Who may sign up?" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByLabelText("Email addresses"),
      ),
    );
  });
});

describe("splitting the entries of a rule", () => {
  it("accepts lines, commas, semicolons and spaces", () => {
    expect(
      splitEntries("a@x.com\nb@x.com, c@x.com;d@x.com  e@x.com\n"),
    ).toEqual(["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"]);
    expect(splitEntries("  \n ")).toEqual([]);
  });
});
