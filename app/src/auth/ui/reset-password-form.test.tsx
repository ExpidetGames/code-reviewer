// @vitest-environment jsdom
// Pins down the form behind a password reset link: the two passwords have to match before anything is
// sent, the server's reasons are shown as sentences, and a link that is not valid says so and what to do.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../../ui/json-request.ts";
import { ResetPasswordForm } from "./reset-password-form.tsx";

afterEach(cleanup);

function answer(status: number, body: unknown): FetchLike {
  return vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

async function fillAndSend(
  fetchImpl: FetchLike,
  password = "a-long-new-passphrase",
  repeat = password,
) {
  const user = userEvent.setup();
  render(<ResetPasswordForm token={"t".repeat(43)} fetchImpl={fetchImpl} />);
  await user.type(screen.getByLabelText("New password"), password);
  await user.type(screen.getByLabelText("Repeat the password"), repeat);
  await user.click(screen.getByRole("button", { name: "Set the password" }));
}

describe("the form of a reset link", () => {
  // #98-AD-17
  it("sends the token and the new password, and then points to the sign-in", async () => {
    const fetchImpl = answer(200, { ok: true });

    await fillAndSend(fetchImpl);

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("changed"),
    );
    expect(
      screen.getByRole("link", { name: "Sign in" }).getAttribute("href"),
    ).toBe("/login");
    const call = vi.mocked(fetchImpl).mock.calls[0];
    expect(call?.[0]).toBe("/api/password-reset");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      token: "t".repeat(43),
      password: "a-long-new-passphrase",
    });
  });

  it("does not send anything when the two passwords differ", async () => {
    const fetchImpl = answer(200, { ok: true });

    await fillAndSend(
      fetchImpl,
      "a-long-new-passphrase",
      "something-else-entirely",
    );

    expect(screen.getByRole("alert").textContent).toContain("not the same");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // #98-AD-17
  it("shows the reason when the password does not pass the password rule", async () => {
    await fillAndSend(
      answer(422, {
        error: "invalid_input",
        issues: [{ field: "password", code: "password_too_common" }],
      }),
    );

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("too common"),
    );
  });

  // #98-AD-18
  it("says that the link is not valid, and what to do, when the server refuses the token", async () => {
    await fillAndSend(answer(400, { error: "invalid_token" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(
        /not valid any more.*admin reset-password/s,
      ),
    );
  });

  it("asks to wait when the server says there were too many attempts", async () => {
    await fillAndSend(answer(429, { error: "rate_limited" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Wait a minute"),
    );
  });
});

describe("a page without a token", () => {
  it("says that the link is incomplete instead of showing a form that cannot work", () => {
    render(<ResetPasswordForm token={null} />);

    expect(screen.getByRole("alert").textContent).toContain("incomplete");
    expect(screen.queryByLabelText("New password")).toBeNull();
  });
});
