// SPDX-License-Identifier: Apache-2.0

// Pins down the warning at start about the test stack's mail outbox: one line when its variables are set (so
// nobody runs a real deployment that sends no mail without noticing), nothing otherwise, and never a value.
import { describe, expect, it, vi } from "vitest";
import { warnAboutTestMailOutbox } from "./startup.ts";

describe("the warning about the test mail outbox", () => {
  it("is one line naming the variables when both are set, and not the file", () => {
    const warn = vi.fn();

    const warned = warnAboutTestMailOutbox(
      {
        ALLOW_TEST_MAIL_OUTBOX: "true",
        TEST_MAIL_OUTBOX_FILE: "/secret/path.jsonl",
      },
      { warn },
    );

    expect(warned).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      "TEST_MAIL_OUTBOX_ACTIVE",
    );
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("/secret/path.jsonl");
  });

  it.each([
    { ALLOW_TEST_MAIL_OUTBOX: "true" },
    { TEST_MAIL_OUTBOX_FILE: "/tmp/x.jsonl" },
  ])("says that %j has no effect on its own", (env) => {
    const warn = vi.fn();

    expect(warnAboutTestMailOutbox(env, { warn })).toBe(true);
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      "TEST_MAIL_OUTBOX_INCOMPLETE",
    );
  });

  it("says nothing when neither is set", () => {
    const warn = vi.fn();

    expect(warnAboutTestMailOutbox({ SMTP_HOST: "x" }, { warn })).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
