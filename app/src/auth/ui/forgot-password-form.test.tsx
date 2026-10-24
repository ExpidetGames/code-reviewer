// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the form that asks for a reset link by mail: it sends the address, and says the same thing
// whatever the address is, and the server's reasons are shown as sentences.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../../ui/json-request.ts";
import { ForgotPasswordForm } from "./forgot-password-form.tsx";

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

async function ask(fetchImpl: FetchLike, address = "person@example.com") {
  const user = userEvent.setup();
  render(<ForgotPasswordForm fetchImpl={fetchImpl} />);
  await user.type(screen.getByLabelText("Email address"), address);
  await user.click(screen.getByRole("button", { name: "Send me a link" }));
}

describe("the form that asks for a reset link", () => {
  // #100-SM-10
  it("sends the address and says to check the inbox without saying whether there is an account", async () => {
    const fetchImpl = answer(200, { ok: true });

    await ask(fetchImpl);

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "Check your inbox",
      ),
    );
    expect(screen.getByRole("status").textContent).toContain("If this address");
    const call = vi.mocked(fetchImpl).mock.calls[0];
    expect(call?.[0]).toBe("/api/password-reset/request");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      email: "person@example.com",
    });
  });

  // #100-SM-11
  it("says the same for every address", async () => {
    const first = answer(200, { ok: true });
    await ask(first, "known@example.com");
    await waitFor(() => screen.getByRole("status"));
    const known = screen.getByRole("status").textContent;
    cleanup();

    await ask(answer(200, { ok: true }), "nobody@example.com");
    await waitFor(() => screen.getByRole("status"));

    expect(screen.getByRole("status").textContent).toBe(known);
  });

  it.each([
    [422, "invalid_input", "Enter a valid email address."],
    [429, "rate_limited", "Too many requests for this address"],
    [404, "not_available", "not available here"],
    [503, "unavailable", "not available right now"],
  ])("shows a sentence for %i %s", async (status, code, sentence) => {
    await ask(answer(status, { error: code }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(sentence),
    );
  });
});
