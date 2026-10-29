// SPDX-License-Identifier: LicenseRef-Proprietary

// What the check run of a review says for each state of its job (#405). Pure: the status of the job and a few
// facts of its result go in, what GitHub shows comes out. The check is NEVER red (the maintainer's rule): the
// conclusion is `success` for a finished review and `neutral` for everything else (a failure, a timeout, a cancel, a
// newer commit that replaced the run), always with a reason in words. The text is fixed sentences, counts, a code
// of the plain shape of one and a validated link; nothing a pull request or a runner wrote is copied into it.
import type { ReviewCheck } from "../integrations/types.ts";
import type { ProductIdentity } from "../product-identity/identity.ts";
import type { JobStatus } from "../db/job-status.ts";
import { describeErrorCode } from "../runs/error-copy.ts";
import type { ReviewFindings } from "../runner-api/contract.ts";
import { safeLink, type VerdictDecision } from "./verdict.ts";

/** The facts of a job the check run is made from. */
export type CheckSubject = {
  status: JobStatus;
  /** The code of a failed or cancelled job. */
  errorCode: string | null;
  /** The link to the review comment, when the runner reported one. */
  commentUrl: string | null;
  /** What the runner said was open after a successful review; null when it did not say. */
  findings: ReviewFindings | null;
  /** Why a Dynamic review was wrapped up early (`cost_limit`, `time_limit`), or null. */
  stoppedEarly: string | null;
  /** What the app decided about the review verdict of a successful review; absent where it is not decided. */
  verdict?: VerdictDecision;
};

export type CheckText = Pick<
  ReviewCheck,
  "status" | "conclusion" | "title" | "summary" | "detailsUrl"
>;

const STOPPED_EARLY_TEXT: Readonly<Record<string, string>> = {
  cost_limit: "The review stopped at its cost limit and may be incomplete.",
  project_cost_limit:
    "The review stopped at the cost limit set for this project and may be incomplete. You can change the limit under Limits in the project settings.",
  time_limit: "The review stopped at its time limit and may be incomplete.",
  token_limit: "The review stopped at its token limit and may be incomplete.",
};

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function findingsLine(findings: ReviewFindings | null): string | null {
  if (findings === null) return null;
  if (findings.open === 0) return "No open findings.";
  const { bySeverity } = findings;
  if (bySeverity === null) return `${plural(findings.open, "open finding")}.`;
  return `${plural(findings.open, "open finding")}: P0 ${String(bySeverity.P0)} · P1 ${String(bySeverity.P1)} · P2 ${String(bySeverity.P2)} · P3 ${String(bySeverity.P3)}`;
}

const VERDICT_SKIP_TEXT: Readonly<Record<string, string>> = {
  review_incomplete:
    "the review did not cover everything (a finding was dropped, files were left out, or it stopped at a limit)",
  no_severity:
    "a Diff Review has no severities, so the setting for blocking findings cannot judge it",
  findings_unknown: "the runner did not report which findings are open",
  no_model_work: "the review made no model call",
};

/** What happens to an earlier request for changes of the app, by the reason no verdict was submitted. */
const VERDICT_SKIP_WAY_OUT: Readonly<Record<string, string>> = {
  review_incomplete: "stays until a complete review replaces it",
  no_model_work: "stays until a complete review replaces it",
  findings_unknown:
    "stays until a review reports its findings or it is dismissed by hand",
  // No later review of the project submits anything under this setting: only a change of the setting does.
  no_severity:
    "stays: a Diff Review submits no verdict under the setting for blocking findings. Choose Any finding in the project settings to get one, or Off to have it dismissed, or dismiss it by hand",
};

/** What a successful review says about its verdict when it submitted none; empty when it submitted one. */
function verdictLine(
  product: ProductIdentity,
  verdict: VerdictDecision | undefined,
): string | null {
  if (verdict === undefined || verdict.kind === "submit") return null;
  if (verdict.reason === "off")
    return "The review verdict is switched off for this project.";
  const because = VERDICT_SKIP_TEXT[verdict.reason] ?? "of an unknown reason";
  const wayOut =
    VERDICT_SKIP_WAY_OUT[verdict.reason] ??
    "stays until it is dismissed by hand";
  return `No review verdict was submitted: ${because}. An earlier request for changes by ${product.name} on this pull request ${wayOut}.`;
}

function linkLine(commentUrl: string | null): string | null {
  const link = safeLink(commentUrl);
  return link === null ? null : `[Read the review](${link})`;
}

function paragraphs(...parts: Array<string | null>): string {
  return parts.filter((part): part is string => part !== null).join("\n\n");
}

/** The reason a job did not finish, in words, with its code when it has the shape of one. */
function reasonLine(
  product: ProductIdentity,
  errorCode: string | null,
  stoppedEarly: string | null,
): string {
  if (errorCode === null) return "The review did not finish.";
  const described = describeErrorCode(product, errorCode, stoppedEarly);
  return described.code === null
    ? described.text
    : `${described.text} (\`${described.code}\`)`;
}

export function describeCheck(
  product: ProductIdentity,
  subject: CheckSubject,
): CheckText {
  const link = safeLink(subject.commentUrl);
  const details = link === null ? {} : { detailsUrl: link };
  switch (subject.status) {
    case "queued":
      return {
        status: "queued",
        title: "Waiting",
        summary:
          "A review of this commit is waiting for a worker. It starts as soon as one is free.",
      };
    case "running":
      return {
        status: "in_progress",
        title: "Reviewing",
        summary: "A review of this commit is running.",
      };
    case "succeeded":
      return {
        status: "completed",
        conclusion: "success",
        title: "Review finished",
        summary: paragraphs(
          findingsLine(subject.findings),
          subject.stoppedEarly === null
            ? null
            : (STOPPED_EARLY_TEXT[subject.stoppedEarly] ?? null),
          verdictLine(product, subject.verdict),
          linkLine(subject.commentUrl),
        ),
        ...details,
      };
    case "superseded":
      return {
        status: "completed",
        conclusion: "neutral",
        title: "Superseded by a newer commit",
        summary:
          "A newer commit replaced this review, so it was stopped or never started. The review of the newer commit has its own check.",
      };
    case "cancelled":
      return {
        status: "completed",
        conclusion: "neutral",
        title: "Review cancelled",
        summary: paragraphs(
          reasonLine(product, subject.errorCode, subject.stoppedEarly),
          "This check is informational and never blocks a merge.",
        ),
      };
    case "failed":
      return {
        status: "completed",
        conclusion: "neutral",
        title: "Review did not finish",
        summary: paragraphs(
          reasonLine(product, subject.errorCode, subject.stoppedEarly),
          linkLine(subject.commentUrl),
          "This check is informational and never blocks a merge. A new push or a review request runs the review again.",
        ),
        ...details,
      };
  }
}
