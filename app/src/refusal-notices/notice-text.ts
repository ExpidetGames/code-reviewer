// SPDX-License-Identifier: Apache-2.0

// The body of the notice (#281) and its hidden marker. The body takes the code, the period and the instance's
// link and nothing else, so no part of a pull request (title, branch, description, comments) and no figure can
// reach it. The words are in src/copy/refusal-notice.ts.
import {
  NOTICE_ADD_CREDIT_WHO,
  NOTICE_BALANCE_NEGATIVE,
  NOTICE_INSUFFICIENT_BALANCE,
  NOTICE_LEAD,
  NOTICE_MONTHLY_LIMIT_REACHED,
  NOTICE_MONTHLY_LIMIT_WHO,
  NOTICE_REVIEWS_PAUSED_FOR_A_WHILE,
  NOTICE_SETTINGS_LINK_TEXT,
  NOTICE_TRY_AGAIN_LATER,
  noticeMonthlyLimitAt,
  noticeAddCreditAt,
  NOTICE_PLAN_PAGE_LINK_TEXT,
  NOTICE_QUOTA_EXHAUSTED,
  NOTICE_WHO_CAN_ACT,
  NOTICE_WORKSPACE_SUSPENDED,
  noticeWhoCanActAt,
} from "../copy/refusal-notice.ts";

/**
 * The refusals that get a notice. The others (`entitlements_invalid`, `llm_not_configured`, `billing_rates_incomplete`: the
 * operator's side, and `billing_limits_unreadable`) do not. `insufficient_balance` and `balance_negative` (#498) are the
 * balance's, `monthly_limit_reached` and `reviews_paused` (#499) the limits': keep the check on `refusal_notices.code`
 * (migrations `20261021090000_widen_refusal_notice_codes` and `20261021190000_widen_refusal_notice_codes_for_limits`) in step
 * with this list.
 */
export const NOTICE_CODES = [
  "quota_exhausted",
  "workspace_suspended",
  "insufficient_balance",
  "balance_negative",
  "monthly_limit_reached",
  "reviews_paused",
] as const;
export type NoticeCode = (typeof NOTICE_CODES)[number];

/** The refusals about the balance: their link is the workspace settings, not the plan page, and they are keyed by head. */
export const BALANCE_NOTICE_CODES = [
  "insufficient_balance",
  "balance_negative",
] as const satisfies readonly NoticeCode[];

export function isBalanceNoticeCode(code: NoticeCode): boolean {
  return (BALANCE_NOTICE_CODES as readonly string[]).includes(code);
}

/**
 * Which page a notice points to: the workspace settings for the balance and the monthly limit (a person of the workspace can
 * act there), the plan page for a quota or a suspension (the operator's), and none for the hidden brake (nobody in the workspace
 * can lift it).
 */
export function noticeLinkKind(code: NoticeCode): "settings" | "plan" | "none" {
  if (isBalanceNoticeCode(code) || code === "monthly_limit_reached")
    return "settings";
  return code === "reviews_paused" ? "none" : "plan";
}

export function isNoticeCode(code: string): code is NoticeCode {
  return (NOTICE_CODES as readonly string[]).includes(code);
}

export const NOTICE_MARKER_PREFIX = "<!-- code-reviewer:refusal-notice";

/**
 * The hidden marker of a notice of one period. A second app instance that is unsure whether the first one
 * posted (it stopped in between) looks for it before it posts. The period is an ISO 8601 timestamp the app
 * itself wrote, so it holds nothing that could end the comment early.
 */
export function noticeMarker(periodStart: string): string {
  return `${NOTICE_MARKER_PREFIX} period=${periodStart} -->`;
}

/** Whether a comment is the notice of this period (it holds the marker). */
export function hasNoticeMarker(body: string, periodStart: string): boolean {
  return body.includes(noticeMarker(periodStart));
}

const REASON_OF: Record<NoticeCode, string> = {
  quota_exhausted: NOTICE_QUOTA_EXHAUSTED,
  workspace_suspended: NOTICE_WORKSPACE_SUSPENDED,
  insufficient_balance: NOTICE_INSUFFICIENT_BALANCE,
  balance_negative: NOTICE_BALANCE_NEGATIVE,
  monthly_limit_reached: NOTICE_MONTHLY_LIMIT_REACHED,
  reviews_paused: NOTICE_REVIEWS_PAUSED_FOR_A_WHILE,
};

function whoCanAct(code: NoticeCode, link: string | null): string {
  if (code === "reviews_paused") return NOTICE_TRY_AGAIN_LATER;
  if (code === "monthly_limit_reached")
    return link === null
      ? NOTICE_MONTHLY_LIMIT_WHO
      : noticeMonthlyLimitAt(NOTICE_SETTINGS_LINK_TEXT, link);
  if (isBalanceNoticeCode(code))
    return link === null
      ? NOTICE_ADD_CREDIT_WHO
      : noticeAddCreditAt(NOTICE_SETTINGS_LINK_TEXT, link);
  return link === null
    ? NOTICE_WHO_CAN_ACT
    : noticeWhoCanActAt(NOTICE_PLAN_PAGE_LINK_TEXT, link);
}

/**
 * `link` is the page the sentence points to, or null when there is none: the plan page of the workspace when the instance has
 * one (a limit or a suspension), the workspace settings (a refusal for the balance). `periodStart` is the key the notice is
 * recorded under: a period, or `head:` and a commit id for the balance (`notice-key.ts`).
 */
export function noticeBody(
  code: NoticeCode,
  periodStart: string,
  link: string | null,
): string {
  return [
    `**${NOTICE_LEAD}**`,
    "",
    `${REASON_OF[code]} ${whoCanAct(code, link)}`,
    "",
    noticeMarker(periodStart),
  ].join("\n");
}
