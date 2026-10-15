# Refusal notices (#281)

When the claim refuses a job for a limit or a suspension of its workspace (`quota_exhausted`,
`workspace_suspended`, `src/usage/README.md`, "Limits and suspension at claim"), the job ends as a failed run and
nobody on the pull request would hear of it. This module posts **one short comment on the pull request**, as the
app, so the bot is not silent. Part of #268.

## What happens

1. The claim fails the job and, after its transaction committed, calls `onRefused` with the job id, the workspace id,
   the code and the **period start** the refusal was decided under (`ClaimRefusal.periodStart`, from the entitlements
   the claim resolved anyway). `jobs/shared.ts` hands it to `noticeOfRefusal` (`shared.ts`), which runs the service
   with `runAfterResponse` (Next's `after()`, so a serverless platform keeps the function alive for it; never a timer).
   `entitlements_invalid` has no period and no notice.
2. `service.ts` (`onRefused`) loads the job, then:
   - **stops at once** if the pull request already has a notice for the period (`posted`, `dropped`, or an attempt that
     is still running): no call to GitHub;
   - reads the pull request through the provider (`getPullRequest`): a **closed** one gets no notice (and a pending
     record is `dropped`); a **draft** gets none when the refused job was an automatic review (trigger `webhook`),
     because automatic review skips drafts, but does when somebody asked for the review (a comment command, the start
     button);
   - takes the record (`begin`, one statement, below), then posts through the provider
     (`postPullRequestNotice`).
3. The comment is not edited or deleted when the limit later lifts; the next review's own comment follows it.

No runner is involved and no model is called: the notice uses the installation of the job's connection, with a token
of its own that is limited to the one repository and to the comment permission (`issues: write`, `metadata: read`;
`NOTICE_TOKEN_PERMISSIONS`) and is switched off after the call. A refused job has no credentials of its own anyway.

## One per pull request and period

`refusal_notices` (`db/repositories/refusal-notices-repository.ts`, scoped to the workspace) has one row per
workspace, repository, pull request number and **period start** (unique index). `begin` is one
`insert ... on conflict do update ... where` statement, so of several callers, several app instances included,
exactly one gets the notice to post:

| State     | Meaning                                     | Taken again?                                              |
| --------- | ------------------------------------------- | --------------------------------------------------------- |
| `pending` | to be posted; `attempts`, `next_attempt_at` | only when `next_attempt_at` has passed and `attempts < 3` |
| `posted`  | the comment is on the pull request          | never                                                     |
| `dropped` | the pull request was closed                 | never                                                     |

A second push or a manual review in the same period finds the row and posts nothing; a later `period_start` is a new
row and may post again. The comment carries a hidden marker (`<!-- code-reviewer:refusal-notice period=<start> -->`):
when an attempt follows one that may have posted and stopped before it noted it (`attempts > 1`), the provider first
looks for **its own** comment (author `<slug>[bot]`) that holds the marker, changed since the first attempt, and posts
nothing if there is one.

## Failure is quiet and bounded

A notice is best effort. A failure never changes the job (it is `failed` with its code already), never throws into
the claim, and is **one log line with a stable code and ids only** (`[notices] REFUSAL_NOTICE_FAILED workspace=..
repository=.. pr=.. code=INTEGRATION_ACCESS_... attempt=n`; never a name, a title, a token or the text). The record
stays `pending` with `next_attempt_at` = now + 5 minutes × the attempts made; at most **3 attempts** are made. Retries
come from:

- the next refusal on the same pull request (a new push), once the wait is over;
- the **cron sweep** (`dispatch/sweep.ts`, step `notices`, serverless deployments, #328), which tries at most 20 due
  notices per run (`retryDue`, `listDueRefusalNotices`). A server that does not run the sweep retries on the next
  refusal only.

Inside one process the posts run one after the other, so a backlog refused in one claim never opens many requests at
GitHub at once.

## The text

English, fixed sentences in `src/copy/refusal-notice.ts`, put together by `notice-text.ts` from **the code, the period
and the link, and nothing else**: no pull request text (title, branch, description) can reach it. It says that no
review ran for this change, that the workspace has used the reviews included for the current period (or that reviews
are paused for this workspace, with no reason), and that the Owners and Admins of the workspace can act. No amount, no
count, no price, no model name, no reason for a suspension.

**The link.** With a plan page configured the sentence links to `/w/<slug>/settings/plan` of the app
(`plan-page.ts`); without one there is no link at all. The instance setting that turns it on is #284's (the
operator-configured page the plan page hands over to); until it exists `getRefusalNoticeService` passes
`planPageUrl: () => null` and no notice has a link. When #284 lands, wiring its setting there is the only change.

## Mixed versions

The table is new and empty; no existing row changes and no contract changes. An app instance from before this change
claims, refuses and logs as before and posts no notice; an instance with it posts one for the refusals it makes. Two
instances of different versions never post two for one pull request and period: the old one posts none.

## Where the tests are

`notice-text.test.ts` (text), `service.integration.test.ts` (end to end on the claim, with the fake GitHub: one
comment, once per period, closed and draft pull requests, GitHub refusing, retries, two instances),
`plan-page.test.ts`, `db/repositories/refusal-notices-repository*.test.ts` (the record, SQLite and Postgres),
`scoped-isolation.integration.test.ts` (workspaces), `integrations/providers/github-app/` (client and provider),
`dispatch/sweep.test.ts` (the sweep step).
