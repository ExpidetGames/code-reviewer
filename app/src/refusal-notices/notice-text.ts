// SPDX-License-Identifier: Apache-2.0

// The body of the notice (#281) and its hidden marker. The body takes the code, the period and the instance's
// link and nothing else, so no part of a pull request (title, branch, description, comments) and no figure can
// reach it. The words are in src/copy/refusal-notice.ts.
import {
  NOTICE_LEAD,
  NOTICE_PLAN_PAGE_LINK_TEXT,
  NOTICE_QUOTA_EXHAUSTED,
  NOTICE_WHO_CAN_ACT,
  NOTICE_WORKSPACE_SUSPENDED,
  noticeWhoCanActAt,
} from "../copy/refusal-notice.ts";

/** The refusals that get a notice. The others (`entitlements_invalid`, `llm_not_configured`) do not. */
export const NOTICE_CODES = ["quota_exhausted", "workspace_suspended"] as const;
export type NoticeCode = (typeof NOTICE_CODES)[number];

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
};

/** `planPageUrl` is the link to the plan page of the workspace, or null when the instance has none. */
export function noticeBody(
  code: NoticeCode,
  periodStart: string,
  planPageUrl: string | null,
): string {
  const whoCanAct =
    planPageUrl === null
      ? NOTICE_WHO_CAN_ACT
      : noticeWhoCanActAt(NOTICE_PLAN_PAGE_LINK_TEXT, planPageUrl);
  return [
    `**${NOTICE_LEAD}**`,
    "",
    `${REASON_OF[code]} ${whoCanAct}`,
    "",
    noticeMarker(periodStart),
  ].join("\n");
}
