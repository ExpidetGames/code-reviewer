// SPDX-License-Identifier: Apache-2.0

// Pins down that the reset page asks the browser not to pass its address on as a referrer: the reset token
// is in the address, and a link on the page or a resource it loads must not receive it. (The page sets it
// as a <meta name="referrer"> tag; the e2e journey checks the tag in the served page.)
import { describe, expect, it, vi } from "vitest";

vi.mock("@/auth/ui/reset-password-form", () => ({
  ResetPasswordForm: () => null,
}));

import { metadata } from "./page.tsx";

describe("the reset page", () => {
  // #98-AD-17
  it("asks browsers not to send its address as a referrer, and not to index it", () => {
    expect(metadata.referrer).toBe("no-referrer");
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
