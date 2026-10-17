// SPDX-License-Identifier: Apache-2.0

// The review verdict the app submits after a successful review (#405): what it is, and the one line it says. Pure:
// the project's setting and the findings the runner reported go in, a decision comes out. Never asks GitHub.
//
// A Dynamic review has severities (P0 to P3): `blocking` means P0, `any` means every open finding. A Diff review
// (PR-Agent) has none: `blocking` cannot tell a blocker from a nit, so it submits nothing for a Diff review (the
// app does not approve what it cannot judge), and `any` counts its active findings. What is not known (the runner
// did not report the findings) and a review that was wrapped up at its cost or time limit never approve; a blocker
// such a review did find still requests changes.
import type { ReviewFindings } from "../runner-api/contract.ts";
import type { ReviewVerdictMode } from "../review-settings/settings.ts";

export type { ReviewVerdictMode } from "../review-settings/settings.ts";
export type FindingCounts = ReviewFindings;

/** Why no review is submitted. Stable: the logs and the tests branch on them. */
export const VERDICT_SKIP_REASONS = [
  "off",
  "no_severity",
  "findings_unknown",
  "review_incomplete",
  "no_model_work",
] as const;
export type VerdictSkipReason = (typeof VERDICT_SKIP_REASONS)[number];

export type VerdictDecision =
  | {
      kind: "submit";
      event: "approve" | "request_changes";
      /** How many findings made it blocking (the P0 ones under `blocking`, every open one under `any`). */
      blocking: number;
    }
  | { kind: "skip"; reason: VerdictSkipReason };

export function decideVerdict(input: {
  mode: ReviewVerdictMode;
  findings: FindingCounts | null;
  /** Why the review was wrapped up before it was done (`cost_limit`, `time_limit`), or null. */
  stoppedEarly: string | null;
  /** How many model calls the run made (`usage.aiCalls`); null when it did not say. */
  modelCalls: number | null;
}): VerdictDecision {
  const { mode, findings, stoppedEarly, modelCalls } = input;
  if (mode === "off") return { kind: "skip", reason: "off" };
  if (findings === null) return { kind: "skip", reason: "findings_unknown" };
  if (findings.bySeverity === null && mode === "blocking")
    return { kind: "skip", reason: "no_severity" };
  const blocking =
    mode === "any" || findings.bySeverity === null
      ? findings.open
      : findings.bySeverity.P0;
  if (blocking > 0)
    return { kind: "submit", event: "request_changes", blocking };
  // Only a review that did its work, covered everything and found nothing approves: the verdict comes from the
  // model's own count, and a count with no work behind it (or one that lost findings) proves nothing.
  if (stoppedEarly !== null || findings.incomplete === true)
    return { kind: "skip", reason: "review_incomplete" };
  if (modelCalls === null || modelCalls === 0)
    return { kind: "skip", reason: "no_model_work" };
  return { kind: "submit", event: "approve", blocking: 0 };
}

/** The hidden text by which the app's own review for a job is recognised if it has to look for it. */
export function verdictMarker(jobId: string): string {
  return `<!-- code-reviewer:verdict job=${jobId} -->`;
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The body of the review: a verdict line, a link to the review comment and the marker. Short, and nothing of the
 * findings or of the pull request: the findings are in the comment it links to.
 */
export function verdictBody(input: {
  jobId: string;
  event: "approve" | "request_changes";
  mode: ReviewVerdictMode;
  blocking: number;
  commentUrl: string | null;
}): string {
  const { event, mode, blocking } = input;
  const kind = mode === "blocking" ? "P0 finding" : "finding";
  const line =
    event === "request_changes"
      ? `**Code Reviewer: changes requested.** ${plural(blocking, kind)} open.`
      : `**Code Reviewer: approved.** No ${mode === "blocking" ? "P0 finding is" : "open finding is"} left.`;
  const link = safeLink(input.commentUrl);
  return [
    link === null ? line : `${line} [Review summary](${link})`,
    "",
    verdictMarker(input.jobId),
  ].join("\n");
}

/** A web address that is safe inside Markdown link syntax, or null. */
export function safeLink(url: string | null): string | null {
  if (url === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  // `href` is percent-encoded (no space, no angle bracket); the parentheses are the only characters left that
  // could end the link.
  return parsed.href.replaceAll("(", "%28").replaceAll(")", "%29");
}
