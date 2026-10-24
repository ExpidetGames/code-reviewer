// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the sender of an instance without a mail server: it says so, and a send is refused with a
// stable code instead of throwing.
import { describe, expect, it } from "vitest";
import { notConfiguredMailSender } from "./sender.ts";

describe("the sender of an instance without a mail server", () => {
  // #99-SR-05
  it("says that no mail server is configured", async () => {
    expect(await notConfiguredMailSender.isConfigured()).toBe(false);
  });

  it("refuses to send with not_configured and does not throw", async () => {
    const result = await notConfiguredMailSender.send({
      to: "a@example.com",
      subject: "s",
      text: "t",
    });

    expect(result).toEqual({ ok: false, error: "not_configured" });
  });
});
