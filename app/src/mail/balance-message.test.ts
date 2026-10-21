// SPDX-License-Identifier: Apache-2.0

// #506: the mails that tell an Owner or an Admin that the prepaid balance is low or empty. They say what happened, the balance
// of that workspace and where to add credit, and nothing about how a review is priced.
import { describe, expect, it } from "vitest";
import { balanceMessage } from "./balance-message.ts";

const LINK = "https://reviews.example.com/w/acme/settings/billing";
const BASE = {
  to: "owner@example.com",
  workspaceName: "Acme",
  balanceText: "$3.20",
  link: LINK,
};

describe("the balance mails", () => {
  // #506-T01
  it("tells a low balance with the balance and the link, in both bodies", () => {
    const message = balanceMessage({ ...BASE, level: "low" });

    expect(message.to).toBe("owner@example.com");
    expect(message.subject).toBe('Low balance in "Acme"');
    for (const body of [message.text, message.html ?? ""]) {
      expect(body).toContain("$3.20");
      expect(body).toContain(LINK);
      expect(body).toContain("Acme");
    }
    expect(message.text).toContain("low");
  });

  // #506-T04
  it("tells an empty balance, and that new reviews wait for credit", () => {
    const message = balanceMessage({
      ...BASE,
      balanceText: "$0.00",
      level: "empty",
    });

    expect(message.subject).toBe('No credit left in "Acme"');
    expect(message.text).toContain("$0.00");
    expect(message.text).toContain("not started");
  });

  // #506-T05
  it("tells a balance below zero as such", () => {
    const message = balanceMessage({
      ...BASE,
      balanceText: "-$1.50",
      level: "negative",
    });

    expect(message.subject).toBe('No credit left in "Acme"');
    expect(message.text).toContain("-$1.50");
    expect(message.text).toContain("below zero");
  });

  // #506-T07
  it.each(["low", "empty", "negative"] as const)(
    "says nothing about rates, formulas, models, providers or limits in the %s mail",
    (level) => {
      const message = balanceMessage({ ...BASE, level });
      for (const body of [message.subject, message.text, message.html ?? ""])
        expect(body).not.toMatch(
          /\b(rate|rates|factor|formula|model|models|provider|stripe|anthropic|openrouter|token|tokens|brake|hourly|minute|minutes|margin|markup)\b/i,
        );
    },
  );

  // #506-T07
  it("makes the workspace name one line and escapes it in the HTML", () => {
    const message = balanceMessage({
      ...BASE,
      workspaceName: 'Acme\r\nBcc: x@evil.test <b>"hi"</b>',
      level: "low",
    });

    expect(message.subject).not.toMatch(/[\r\n]/);
    expect(message.text.split("\n")).not.toContain("Bcc: x@evil.test");
    expect(message.html).not.toContain("<b>");
    expect(message.html).toContain("&lt;b&gt;");
  });
});
