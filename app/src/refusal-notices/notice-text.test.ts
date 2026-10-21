// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  NOTICE_PLAN_PAGE_LINK_TEXT,
  NOTICE_SETTINGS_LINK_TEXT,
  NOTICE_WHO_CAN_ACT,
} from "../copy/refusal-notice.ts";
import {
  NOTICE_MARKER_PREFIX,
  hasNoticeMarker,
  noticeBody,
  noticeMarker,
} from "./notice-text.ts";

const PERIOD = "2026-10-01T00:00:00.000Z";

/** The visible words: the hidden marker is a comment for the app, not text a person reads. */
function visible(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/g, "");
}

describe("the text of the notice", () => {
  // #281-T05
  it("says that no review ran and that the reviews of the period are used, for a limit", () => {
    const text = visible(noticeBody("quota_exhausted", PERIOD, null));
    expect(text).toContain("No review ran for this change.");
    expect(text).toContain("used the reviews included for the current period");
    expect(text).toContain(NOTICE_WHO_CAN_ACT);
  });

  // #281-P3
  it("tells people to contact an Owner or Admin, and does not promise an action only the operator can take", () => {
    for (const code of ["quota_exhausted", "workspace_suspended"] as const) {
      const text = visible(noticeBody(code, PERIOD, null));
      expect(text).toContain("contact an Owner or Admin of this workspace");
      expect(text).not.toMatch(/can act/i);
    }
    const linked = visible(
      noticeBody(
        "quota_exhausted",
        PERIOD,
        "https://app.example/w/acme/settings/plan",
      ),
    );
    expect(linked).toContain("contact an Owner or Admin of this workspace");
    expect(linked).not.toMatch(/can act/i);
  });

  // #281-T04
  it("says that reviews are paused, with no reason, for a suspension", () => {
    const text = visible(noticeBody("workspace_suspended", PERIOD, null));
    expect(text).toContain("No review ran for this change.");
    expect(text).toContain("Reviews are paused for this workspace.");
    expect(text).not.toMatch(/because|overdue|reason|payment|billing/i);
  });

  // #281-T05
  it.each(["quota_exhausted", "workspace_suspended"] as const)(
    "holds no number, amount, currency or model name (%s)",
    (code) => {
      const text = visible(noticeBody(code, PERIOD, null));
      expect(text).not.toMatch(/\d/);
      expect(text).not.toMatch(/[$€£%]/);
      expect(text).not.toMatch(
        /\b(price|cost|usd|eur|dollar|euro|token|model|gpt|claude|plan label|credit)\b/i,
      );
    },
  );

  // #281-T05
  it("takes nothing but the code, the period and the instance's link", () => {
    // The signature is the proof: there is no parameter for a title, a branch, a description or a count.
    expect(noticeBody.length).toBe(3);
  });

  // #281-T09
  it("has no link when the instance has no plan page", () => {
    const text = noticeBody("quota_exhausted", PERIOD, null);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toContain("](");
  });

  it("links to the plan page of the workspace when the instance has one", () => {
    const text = visible(
      noticeBody(
        "quota_exhausted",
        PERIOD,
        "https://app.example/w/acme/settings/plan",
      ),
    );
    expect(text).toContain(
      `[${NOTICE_PLAN_PAGE_LINK_TEXT}](https://app.example/w/acme/settings/plan)`,
    );
    expect(text).not.toContain(NOTICE_WHO_CAN_ACT);
  });

  // #281-T08
  it("carries a hidden marker of the period, which only the app's own notice has", () => {
    const body = noticeBody("quota_exhausted", PERIOD, null);
    expect(body).toContain(noticeMarker(PERIOD));
    expect(noticeMarker(PERIOD).startsWith(NOTICE_MARKER_PREFIX)).toBe(true);
    expect(hasNoticeMarker(body, PERIOD)).toBe(true);
    expect(hasNoticeMarker(body, "2026-11-01T00:00:00.000Z")).toBe(false);
    expect(hasNoticeMarker("No review ran for this change.", PERIOD)).toBe(
      false,
    );
  });
});

describe("the notice of a refusal for the balance", () => {
  const HEAD = "head:0123456789abcdef0123456789abcdef01234567";

  // #498-T03
  it.each(["insufficient_balance", "balance_negative"] as const)(
    "says that no review ran and asks to add credit, without a number, an amount, a rate or a model (%s)",
    (code) => {
      const text = visible(noticeBody(code, HEAD, null));

      expect(text).toContain("No review ran for this change.");
      expect(text).toContain("Add credit to continue");
      expect(text).toContain("Owner or Admin");
      expect(text).not.toMatch(/\d/);
      expect(text).not.toMatch(/[$€£%]/);
      expect(text).not.toMatch(
        /\b(price|cost|usd|eur|dollar|euro|token|model|gpt|claude|rate|factor|formula|minute|tier)\b/i,
      );
      expect(text).not.toMatch(/https?:\/\//);
    },
  );

  // #498-T03
  it("says the balance is below zero for a negative balance and that nothing is left for an empty one", () => {
    expect(visible(noticeBody("balance_negative", HEAD, null))).toContain(
      "below zero",
    );
    expect(visible(noticeBody("insufficient_balance", HEAD, null))).toContain(
      "no credit left",
    );
  });

  // #498-T03
  it("links to the workspace settings when it is given a link", () => {
    const text = visible(
      noticeBody(
        "insufficient_balance",
        HEAD,
        "https://app.example/w/acme/settings",
      ),
    );

    expect(text).toContain(
      `[${NOTICE_SETTINGS_LINK_TEXT}](https://app.example/w/acme/settings)`,
    );
    expect(text).toContain("Add credit to continue");
  });

  // #498-T03
  it("keys the hidden marker on the head, so a new push is told again and the same head once", () => {
    const body = noticeBody("insufficient_balance", HEAD, null);

    expect(body).toContain(noticeMarker(HEAD));
    expect(hasNoticeMarker(body, HEAD)).toBe(true);
    expect(hasNoticeMarker(body, "head:fedcba98")).toBe(false);
  });
});

describe("the notice of a refusal for the monthly limit (#499)", () => {
  const HEAD = "head:0123456789abcdef0123456789abcdef01234567";

  // #499-T01
  it("says that no review ran and that the monthly limit was reached, with no number, amount or name of ours", () => {
    const text = visible(noticeBody("monthly_limit_reached", HEAD, null));

    expect(text).toContain("No review ran for this change.");
    expect(text).toContain("monthly spending limit of this workspace");
    expect(text).toContain("Owner or Admin");
    expect(text).not.toMatch(/\d/);
    expect(text).not.toMatch(/[$€£%]/);
    expect(text).not.toMatch(
      /\b(price|cost|usd|eur|dollar|euro|token|model|gpt|claude|rate|factor|formula|minute|tier|balance|credit)\b/i,
    );
    expect(text).not.toMatch(/https?:\/\//);
  });

  // #499-T01
  it("says who can change it, and links to the workspace settings when it is given a link", () => {
    const plain = visible(noticeBody("monthly_limit_reached", HEAD, null));
    const linked = visible(
      noticeBody(
        "monthly_limit_reached",
        HEAD,
        "https://app.example/w/acme/settings",
      ),
    );

    expect(plain).toContain("can change it");
    expect(linked).toContain(
      `[${NOTICE_SETTINGS_LINK_TEXT}](https://app.example/w/acme/settings)`,
    );
    expect(linked).toContain("Owner or Admin");
  });
});

describe("the notice of the hidden hourly brake (#499)", () => {
  const HEAD = "head:0123456789abcdef0123456789abcdef01234567";

  // #499-T06
  it("says that reviews are paused for a while and never the number, the window or that it counts anything", () => {
    const text = visible(noticeBody("hourly_review_limit", HEAD, null));

    expect(text).toContain("No review ran for this change.");
    expect(text).toContain(
      "Reviews are paused for this workspace for a while.",
    );
    expect(text).toContain("try again later");
    expect(text).not.toMatch(/\d/);
    expect(text).not.toMatch(
      /\b(hour|hours|hourly|minute|minutes|per|every|limit|limited|rolling|window|maximum|too many|brake|abuse|count)\b/i,
    );
    expect(text).not.toMatch(/[$€£%]/);
  });

  // #499-T06
  it("points to no page, because nobody in the workspace can lift it, even when it is given a link", () => {
    const text = visible(
      noticeBody(
        "hourly_review_limit",
        HEAD,
        "https://app.example/w/acme/settings",
      ),
    );

    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toContain("](");
  });

  // #499-T06
  it("keys the hidden marker on the head, like the balance", () => {
    const body = noticeBody("hourly_review_limit", HEAD, null);

    expect(hasNoticeMarker(body, HEAD)).toBe(true);
    expect(hasNoticeMarker(body, "head:fedcba98")).toBe(false);
  });
});
