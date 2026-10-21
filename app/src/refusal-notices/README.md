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
   The refusal carries the repository, the pull request number and the trigger of the job, so no job is read again; and
   `refusal-batch.ts` gathers the refusals of one claim and keeps **one per workspace, repository, pull request and
   period** (a review somebody asked for wins over an automatic one) before it schedules **one** `after()` callback for
   the lot, however large the backlog a suspension just failed.
2. `service.ts` (`onRefused`), for each of them:
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
| `dropped` | nothing will be posted (closed, gone)       | never                                                     |

A second push or a manual review in the same period finds the row and posts nothing; a later `period_start` is a new
row and may post again. The comment carries a hidden marker (`<!-- code-reviewer:refusal-notice period=<start> -->`):
when an attempt follows one that may have posted and stopped before it noted it (`attempts > 1`), the provider first
looks for **its own** comment (author `<slug>[bot]`) that holds the marker, changed since the first attempt, and posts
nothing if there is one.

## Failure is quiet and bounded

A notice is best effort. A callback that is cut off part-way (a serverless function can be) leaves the pull requests it
did not reach without a row, and no sweep knows of them; the next refusal on those pull requests tries again, which is
acceptable for a best-effort notice.

**A notice that is due again always moves on**, so the sweep cannot be stuck on rows it cannot work: one whose
repository or connection is gone or no longer active, or whose pull request is gone (404) or closed, is `dropped`; one
whose pull request cannot be read for now is counted as an attempt (`begin`) and waits like a failed post, so after 3
attempts it is no longer listed. Only a notice that was never taken has no row to move on, and it is retried by the
next refusal only.

A failure never changes the job (it is `failed` with its code already), never throws into
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
are paused for this workspace, with no reason), and to contact an Owner or Admin of the workspace (the limits and the suspension are set by the operator of the instance, so the text promises no action a workspace role can take). No amount, no
count, no price, no model name, no reason for a suspension.

**The link.** While the instance has an operator-configured plan management page (`plan_management_url`, #284) the
sentence links to the plan page of the app, `planReturnPath` (`src/plan-handoff/return-path.ts`: `/w/<slug>/settings/plan`; `plan-page.ts`, the configured address of the app, never a request);
without one there is no link at all. `getRefusalNoticeService` passes `createPlanPageUrlResolver` (`plan-link.ts`), which reads the setting every
time a notice is made, so switching the page on or off takes effect at once. The link is never the operator's page and
carries no token: an Owner or Admin who follows it finds "Manage plan" on the plan page (#282) and is handed over from
there (`src/plan-handoff/README.md`). A setting that cannot be read costs the notice only its link. The plan page
(#282, `src/usage/README.md`) shows what the workspace may use and has used.

## The balance (#498)

A job the claim refuses because the balance cannot hold it (`insufficient_balance`, `balance_negative`) gets a notice too. The text is "No review
ran for this change." and "This workspace has no credit left for reviews." (or "The balance of this workspace is below zero."), then "Add credit to
continue": with a link to the workspace settings (`/w/<slug>/settings`, `settingsUrl`; the balance page of #505 will take it over) it says an Owner or
Admin can do so there, without one it says to contact an Owner or Admin. It names no amount, rate, formula or model. It is **one per pull request head**,
not per period: the row is recorded under `head:<commit id>` in the `period_start` column (`notice-key.ts`; a value that is no commit id gets no notice),
so a new push after a top-up that was not enough is told again and the same head is told once. `billing_rates_incomplete` and `billing_hold_released`
have no notice: they are the operator's side. The check of `refusal_notices.code` took the two codes with migration `20261021090000_widen_refusal_notice_codes`.

## The limits (#499)

A job the claim refuses for the workspace's own monthly total limit (`monthly_limit_reached`) or for the hidden hourly brake (`reviews_paused`)
gets a notice too, keyed by the head like the balance's (`head:<commit id>`). The monthly limit's text is "The monthly spending limit of this workspace
was reached." and who can change it: with a link to the workspace settings (`settingsUrl`) "An Owner or Admin of this workspace can change it on the
workspace settings", without one "An Owner or Admin of this workspace can change it." The brake's text is "Reviews are paused for this workspace for a
while." and "Please try again later.": **it never names the number of reviews, the window it counts over, or that it is a limit at all**, and it points to no
page, because nobody in the workspace can lift it (`noticeLinkKind`). Neither text holds a digit or an amount. `billing_limits_unreadable` has no notice:
it is the operator's side. The check of `refusal_notices.code` took the two codes with migration
`20261021190000_widen_refusal_notice_codes_for_limits`.

## Not covered

- Other refusals (`llm_not_configured`, `entitlements_invalid`, a gate that is off) get no notice: out of scope of #281.
- A workspace suspended in the seconds between a Dispatcher's claim and the Worker's fetch (`runner-api/worker-fetch.ts`,
  `standingRefusal`) ends the job with `workspace_suspended` without a notice; the next refused push posts it.

## Mixed versions

The table is new and empty; no existing row changes and no contract changes. An app instance from before this change
claims, refuses and logs as before and posts no notice; an instance with it posts one for the refusals it makes. Two
instances of different versions never post two for one pull request and period: the old one posts none.

## Where the tests are

`notice-text.test.ts` (text), `service.integration.test.ts` (end to end on the claim, with the fake GitHub: one
comment, once per period, closed and draft pull requests, GitHub refusing, retries, two instances),
`plan-page.test.ts`, `plan-link.integration.test.ts` (the link follows the setting), `db/repositories/refusal-notices-repository*.test.ts` (the record, SQLite and Postgres),
`scoped-isolation.integration.test.ts` (workspaces), `integrations/providers/github-app/` (client and provider),
`dispatch/sweep.test.ts` (the sweep step).
