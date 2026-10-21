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

/**
 * Who to turn to, when the instance has no page to point to. Nothing a workspace role can change is promised: the
 * limits and the suspension are set by the operator of the instance.
 */
export const NOTICE_WHO_CAN_ACT =
  "Please contact an Owner or Admin of this workspace.";

/** Who to turn to and where to read more, when the instance has a plan page (the link text is the page's name). */
export function noticeWhoCanActAt(linkText: string, url: string): string {
  return `Please contact an Owner or Admin of this workspace, who can find out more on [${linkText}](${url}).`;
}

/** The name of the plan page in the link. */
export const NOTICE_PLAN_PAGE_LINK_TEXT = "the plan page";

/**
 * Why, for a workspace whose balance cannot hold a review (#498). No amount, no rate, no formula and no model is named: a
 * member reads this, and what a review costs is the operator's business.
 */
export const NOTICE_INSUFFICIENT_BALANCE =
  "This workspace has no credit left for reviews.";
export const NOTICE_BALANCE_NEGATIVE =
  "The balance of this workspace is below zero.";

/** Who to turn to for a refusal for the balance, when there is no page to point to. */
export const NOTICE_ADD_CREDIT_WHO =
  "Add credit to continue: please contact an Owner or Admin of this workspace.";

/** The same, with the page where an Owner or Admin finds it (the link text is the page's name). */
export function noticeAddCreditAt(linkText: string, url: string): string {
  return `Add credit to continue: an Owner or Admin of this workspace can do so on [${linkText}](${url}).`;
}

/** The name of the workspace settings in the link of a refusal for the balance. */
export const NOTICE_SETTINGS_LINK_TEXT = "the workspace settings";

/**
 * Why, for a workspace whose own monthly spending limit was reached (#499). It names no amount of ours and not the limit the
 * customer set: the Owner or Admin who set it finds it in the settings.
 */
export const NOTICE_MONTHLY_LIMIT_REACHED =
  "The monthly spending limit of this workspace was reached.";

/** Who to turn to for the monthly limit, when there is no page to point to. */
export const NOTICE_MONTHLY_LIMIT_WHO =
  "An Owner or Admin of this workspace can change it.";

/** The same, with the page where an Owner or Admin changes it (the link text is the page's name). */
export function noticeMonthlyLimitAt(linkText: string, url: string): string {
  return `An Owner or Admin of this workspace can change it on [${linkText}](${url}).`;
}

/**
 * Why, for a workspace the hidden abuse brake paused (#499). It says reviews are paused for a while and nothing else: not the
 * number of reviews, not the period it counts, not that it is a limit. Nobody in the workspace can lift it, so it points to no page.
 */
export const NOTICE_REVIEWS_PAUSED_FOR_A_WHILE =
  "Reviews are paused for this workspace for a while.";
export const NOTICE_TRY_AGAIN_LATER = "Please try again later.";
