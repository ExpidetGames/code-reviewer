// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins down the forms of the sign-up and the verification: what they send, that the two passwords have
// to match before anything is sent, that the confirmation of an address is a click and not a page view,
// and that the words on screen are true whether or not the address may sign up.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../../ui/json-request.ts";
import { ResendForm } from "./resend-form.tsx";
import { SignUpForm } from "./sign-up-form.tsx";
import { VerifyEmailForm } from "./verify-email-form.tsx";

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

async function fillSignUp(
  fetchImpl: FetchLike,
  password = "a-long-new-passphrase",
  repeat = password,
) {
  const user = userEvent.setup();
  render(<SignUpForm fetchImpl={fetchImpl} />);
  await user.type(screen.getByLabelText("Email address"), "new@example.com");
  await user.type(screen.getByLabelText("Password"), password);
  await user.type(screen.getByLabelText("Repeat the password"), repeat);
  await user.click(screen.getByRole("button", { name: "Create account" }));
}

describe("the sign-up form", () => {
  // #99-SR-23
  it("sends the address and the password, and says to check the inbox when a mail follows", async () => {
    const fetchImpl = answer(200, { ok: true, next: "verify_email" });

    await fillSignUp(fetchImpl);

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "Check your inbox",
      ),
    );
    const call = vi.mocked(fetchImpl).mock.calls[0];
    expect(call?.[0]).toBe("/api/sign-up");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      email: "new@example.com",
      password: "a-long-new-passphrase",
    });
  });

  // #99-SR-08
  it("points to the sign-in when no mail follows", async () => {
    await fillSignUp(answer(200, { ok: true, next: "sign_in" }));

    await waitFor(() =>
      expect(
        screen
          .getByRole("link", { name: "Back to sign in" })
          .getAttribute("href"),
      ).toBe("/login"),
    );
  });

  // #170-T03
  it("shows one success card and a single sign-in link after the sign-up", async () => {
    await fillSignUp(answer(200, { ok: true, next: "verify_email" }));

    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());

    expect(screen.getAllByRole("status")).toHaveLength(1);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/login");
    expect(links[0]?.textContent).toMatch(/back to sign in/i);
  });

  // #99-SR-09
  it("does not say that an address is allowed or that an account was made", async () => {
    await fillSignUp(answer(200, { ok: true, next: "verify_email" }));

    await waitFor(() => screen.getByRole("status"));
    expect(screen.getByRole("status").textContent).toMatch(
      /^Check your inbox\. If this address may sign up/,
    );
    expect(screen.getByRole("status").textContent).not.toMatch(
      /account (was|has been) (created|made)/i,
    );
  });

  it("does not send anything when the two passwords differ", async () => {
    const fetchImpl = answer(200, { ok: true, next: "sign_in" });

    await fillSignUp(
      fetchImpl,
      "a-long-new-passphrase",
      "something-else-entirely",
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("not the same");
  });

  // #99-SR-18
  it("shows the reason of a password the server refuses", async () => {
    await fillSignUp(
      answer(422, {
        error: "invalid_input",
        issues: [{ field: "password", code: "password_too_common" }],
      }),
    );

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("common"),
    );
  });

  // #99-SR-04
  it("shows the reason of an address the server refuses", async () => {
    await fillSignUp(
      answer(422, {
        error: "invalid_input",
        issues: [{ field: "email", code: "invalid_email" }],
      }),
    );

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("valid email"),
    );
  });

  // #99-SR-06
  it.each([
    ["signup_closed", 403, "not open"],
    ["rate_limited", 429, "Too many"],
  ])("explains %s", async (code, status, words) => {
    await fillSignUp(answer(status, { error: code }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(words),
    );
  });
});

describe("the confirmation of an address", () => {
  async function confirm(
    fetchImpl: FetchLike,
    password = "my-sign-up-password",
  ) {
    const user = userEvent.setup();
    render(<VerifyEmailForm token={"t".repeat(43)} fetchImpl={fetchImpl} />);
    await user.type(screen.getByLabelText("Password"), password);
    await user.click(
      screen.getByRole("button", { name: "Confirm email address" }),
    );
  }

  // #99-SR-11
  it("verifies only when the person clicks, with the token and the password, and then points to the sign-in", async () => {
    const fetchImpl = answer(200, { ok: true });
    render(<VerifyEmailForm token={"t".repeat(43)} fetchImpl={fetchImpl} />);
    expect(fetchImpl).not.toHaveBeenCalled();
    cleanup();

    await confirm(fetchImpl);

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("confirmed"),
    );
    const call = vi.mocked(fetchImpl).mock.calls[0];
    expect(call?.[0]).toBe("/api/verify-email");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      token: "t".repeat(43),
      password: "my-sign-up-password",
    });
    expect(
      screen.getByRole("link", { name: "Sign in" }).getAttribute("href"),
    ).toBe("/login");
  });

  it("asks for the password of the sign-up before it sends anything", async () => {
    const fetchImpl = answer(200, { ok: true });
    const user = userEvent.setup();
    render(<VerifyEmailForm token={"t".repeat(43)} fetchImpl={fetchImpl} />);

    await user.click(
      screen.getByRole("button", { name: "Confirm email address" }),
    );

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // #99-SR-12
  it.each([
    ["token_expired", 410, "expired"],
    ["token_used", 409, "used already"],
    ["invalid_token", 400, "link or the password"],
  ])(
    "says what is wrong with a link that gets %s, and offers a new one",
    async (code, status, words) => {
      await confirm(answer(status, { error: code }));

      await waitFor(() =>
        expect(screen.getByRole("alert").textContent).toContain(words),
      );
      expect(
        screen
          .getByRole("link", { name: "Ask for a new link" })
          .getAttribute("href"),
      ).toBe("/verify-email");
    },
  );
});

describe("the request for a new link", () => {
  // #99-SR-13
  it("sends the address and answers the same way for every address", async () => {
    const fetchImpl = answer(200, { ok: true });
    const user = userEvent.setup();
    render(<ResendForm fetchImpl={fetchImpl} />);
    await user.type(
      screen.getByLabelText("Email address"),
      "someone@example.com",
    );

    await user.click(screen.getByRole("button", { name: "Send a new link" }));

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "If this address",
      ),
    );
    const call = vi.mocked(fetchImpl).mock.calls[0];
    expect(call?.[0]).toBe("/api/verify-email/resend");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      email: "someone@example.com",
    });
  });

  it("starts with the address it is given", () => {
    render(
      <ResendForm initialEmail="me@example.com" fetchImpl={answer(200, {})} />,
    );

    expect(
      (screen.getByLabelText("Email address") as HTMLInputElement).value,
    ).toBe("me@example.com");
  });

  // #99-SR-13
  it("says to wait when the limit is reached", async () => {
    const user = userEvent.setup();
    render(
      <ResendForm
        initialEmail="me@example.com"
        fetchImpl={answer(429, { error: "rate_limited" })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Send a new link" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Too many"),
    );
  });
});
