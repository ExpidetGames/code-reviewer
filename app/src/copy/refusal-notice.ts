// SPDX-License-Identifier: Apache-2.0

// The words of the notice a pull request gets when a review is refused (#281). Fixed sentences, one set per
// code: nothing in them comes from the pull request, and none says an amount, a figure, a reason or a name of
// a model. The notice module (src/refusal-notices/) puts them together; nothing else writes them.

/** The first line of every notice. */
export const NOTICE_LEAD = "No review ran for this change.";

/** Why, for a workspace that used the reviews it has for the current period. */
export const NOTICE_QUOTA_EXHAUSTED =
  "This workspace has used the reviews included for the current period.";

/** Why, for a workspace whose reviews are paused. No reason is given on purpose. */
export const NOTICE_WORKSPACE_SUSPENDED =
  "Reviews are paused for this workspace.";

/** Who can act, when the instance has no page to point to. */
export const NOTICE_WHO_CAN_ACT =
  "The Owners and Admins of this workspace can act on this.";

/** Who can act and where, when the instance has a plan page (the link text is the page's name). */
export function noticeWhoCanActAt(linkText: string, url: string): string {
  return `The Owners and Admins of this workspace can act on this on [${linkText}](${url}).`;
}

/** The name of the plan page in the link. */
export const NOTICE_PLAN_PAGE_LINK_TEXT = "the plan page";
