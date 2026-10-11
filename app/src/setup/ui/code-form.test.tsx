// @vitest-environment jsdom
// Pins down the setup code form: it sends the code, goes on when it is accepted, and says in a
// sentence what happened when it is not (a wrong code, a lock, an expired code), never showing a code.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SetupApi } from "./api.ts";
import { CodeForm } from "./code-form.tsx";

afterEach(cleanup);

function renderForm(result: Awaited<ReturnType<SetupApi["submitCode"]>>) {
  const submitCode = vi.fn<SetupApi["submitCode"]>(async () => result);
  const onAccepted = vi.fn();
  render(
    <CodeForm
      api={{ submitCode, complete: vi.fn() }}
      onAccepted={onAccepted}
    />,
  );
  return { submitCode, onAccepted };
}

describe("the setup code form", () => {
  // #97-SU-05
  it("sends the code and goes on when it is accepted", async () => {
    const user = userEvent.setup();
    const { submitCode, onAccepted } = renderForm({
      ok: true,
      data: { ok: true },
    });

    await user.type(screen.getByLabelText("Setup code"), "482913");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(submitCode).toHaveBeenCalledWith("482913");
    expect(onAccepted).toHaveBeenCalledTimes(1);
  });

  it("does not send a code that is not six characters long", async () => {
    const user = userEvent.setup();
    const { submitCode } = renderForm({ ok: true, data: { ok: true } });

    await user.type(screen.getByLabelText("Setup code"), "4829");

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

    await user.type(screen.getByLabelText("Setup code"), "482914");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/not correct/);
    expect(alert.textContent).toMatch(/10 wrong codes/);
    expect(alert.textContent).not.toContain("482914");
    expect(onAccepted).not.toHaveBeenCalled();
  });

  // #97-SU-08
  it("tells the person to restart the app when the setup is locked", async () => {
    const user = userEvent.setup();
    renderForm({ ok: false, status: 423, code: "setup_locked", issues: [] });

    await user.type(screen.getByLabelText("Setup code"), "000000");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Restart the app/,
    );
  });

  it("says where to find the code, and mentions kept data on an existing installation", () => {
    render(<CodeForm existingInstallation />);

    expect(screen.getByText(/docker compose logs app/)).toBeTruthy();
    expect(screen.getByText(/data from before the setup existed/)).toBeTruthy();
  });
});
