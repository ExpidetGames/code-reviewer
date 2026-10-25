// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down that the verification page asks the browser not to pass its address on as a referrer: the token
// of the link is in the address, and a link on the page or a resource it loads must not receive it. (The
// page sets it as a <meta name="referrer"> tag; the e2e journey checks the tag in the served page.)
import { describe, expect, it, vi } from "vitest";

vi.mock("@/auth/actions", () => ({ signOut: () => undefined }));
vi.mock("@/auth/session", () => ({ currentLookup: () => undefined }));
vi.mock("@/signup/ui/verify-email-form", () => ({
  VerifyEmailForm: () => null,
}));
vi.mock("@/signup/ui/verify-email-help", () => ({
  VerifyEmailHelp: () => null,
}));

import { metadata } from "./page.tsx";

describe("the verification page", () => {
  // #99-SR-20
  it("asks browsers not to send its address as a referrer, and not to index it", () => {
    expect(metadata.referrer).toBe("no-referrer");
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
