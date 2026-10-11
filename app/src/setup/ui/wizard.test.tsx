// @vitest-environment jsdom
// Pins down the wizard: three steps in order, the choices are kept while going back and forth, the
// fail-closed hint is shown next to an email or domain rule, the password rule and its reason are
// shown, and the problems the server reports are shown at the field and take the person to its step.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SetupApi } from "./api.ts";
import { splitEntries, Wizard } from "./wizard.tsx";

afterEach(cleanup);

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

describe("the wizard", () => {
  it("asks the three questions in order", async () => {
    const { user } = renderWizard();

    expect(screen.getByRole("heading").textContent).toMatch(
      /How is this instance used/,
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
    expect(
      (screen.getByRole("radio", { name: /Multi-tenant/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
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

describe("splitting the entries of a rule", () => {
  it("accepts lines, commas, semicolons and spaces", () => {
    expect(
      splitEntries("a@x.com\nb@x.com, c@x.com;d@x.com  e@x.com\n"),
    ).toEqual(["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"]);
    expect(splitEntries("  \n ")).toEqual([]);
  });
});
