// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  NOTICE_PLAN_PAGE_LINK_TEXT,
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
