// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins down the setup code form: it sends the code, goes on when it is accepted, and says in a
// sentence what happened when it is not (a wrong code, a lock, an expired code), never showing a code.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SetupApi } from "./api.ts";
import { CodeForm } from "./code-form.tsx";
import { getProductIdentity } from "../../product-identity/current.ts";

afterEach(cleanup);

function renderForm(result: Awaited<ReturnType<SetupApi["submitCode"]>>) {
  const submitCode = vi.fn<SetupApi["submitCode"]>(async () => result);
  const onAccepted = vi.fn();
  render(
    <CodeForm
      product={getProductIdentity()}
      api={{ submitCode, complete: vi.fn() }}
      onAccepted={onAccepted}
    />,
  );
  return { submitCode, onAccepted };
}

/**
 * The code input, named by its role rather than by label text: the form carries the same accessible
 * name ("Setup code"), so `getByLabelText` would find both elements (#172).
 */
function codeInput(): HTMLElement {
  return screen.getByRole("textbox", { name: "Setup code" });
}

describe("the setup code form", () => {
  // #321-T01
  it("points at pnpm setup-code instead of the log of the app", () => {
    render(
      <CodeForm
        product={getProductIdentity()}
        api={{ submitCode: vi.fn(), complete: vi.fn() }}
      />,
    );

    expect(screen.getByText(/pnpm setup-code/)).toBeTruthy();
    expect(screen.queryByText(/docker compose logs app/)).toBeNull();
  });

  // #321-T01
  it("says what to do when the code is used up", async () => {
    const user = userEvent.setup();
    render(
      <CodeForm
        product={getProductIdentity()}
        api={{
          submitCode: vi.fn(async () => ({
            ok: false as const,
            code: "code_used",
            status: 409,
            issues: [],
          })),
          complete: vi.fn(),
        }}
      />,
    );

    await user.type(codeInput(), "482913");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect((await screen.findByText(/already used/)).textContent).toMatch(
      /pnpm setup-code/,
    );
  });
});

describe("the setup code form", () => {
  // #97-SU-05
  it("sends the code and goes on when it is accepted", async () => {
    const user = userEvent.setup();
    const { submitCode, onAccepted } = renderForm({
      ok: true,
      data: { ok: true },
    });

    await user.type(codeInput(), "482913");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(submitCode).toHaveBeenCalledWith("482913");
    expect(onAccepted).toHaveBeenCalledTimes(1);
  });

  it("does not send a code that is not six characters long", async () => {
    const user = userEvent.setup();
    const { submitCode } = renderForm({ ok: true, data: { ok: true } });

    await user.type(codeInput(), "4829");

    expect(screen.getByRole("button", { name: "Continue" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(submitCode).not.toHaveBeenCalled();
  });

  // #97-SU-04
  it("says that the code is wrong and mentions the lock, without repeating the code", async () => {
    const user = userEvent.setup();
    const { onAccepted } = renderForm({
      ok: false,
      status: 403,
      code: "invalid_code",
      issues: [],
    });

    await user.type(codeInput(), "482914");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/not correct/);
    expect(alert.textContent).toMatch(/10 wrong codes/);
    expect(alert.textContent).not.toContain("482914");
    expect(onAccepted).not.toHaveBeenCalled();
  });

  // #97-SU-08
  it("sends the person to pnpm setup-code when the setup is locked", async () => {
    const user = userEvent.setup();
    renderForm({ ok: false, status: 423, code: "setup_locked", issues: [] });

    await user.type(codeInput(), "000000");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /pnpm setup-code/,
    );
  });

  it("says where the code comes from, and mentions kept data on an existing installation", () => {
    render(<CodeForm product={getProductIdentity()} existingInstallation />);

    expect(screen.getByText(/pnpm setup-code/)).toBeTruthy();
    expect(screen.getByText(/data from before the setup existed/)).toBeTruthy();
  });

  // #172-T01
  it("keeps the heading outside the form and gives the form a name", () => {
    render(
      <CodeForm
        product={getProductIdentity()}
        api={{ submitCode: vi.fn(), complete: vi.fn() }}
      />,
    );

    const form = screen.getByRole("form", { name: "Setup code" });
    const heading = screen.getByRole("heading", {
      level: 1,
      name: "Set up code-review.com",
    });

    expect(form.contains(heading)).toBe(false);
    expect(form.contains(codeInput())).toBe(true);
  });
});
