# CR-12 spike: capture the result of a run

Date: 2026-10-10. PR-Agent: `pr-agent==0.47.0`. Runner: `code-reviewer-run-job`
(`runner/src/code_reviewer_runner/`).

## Decision

**The result comes from a comment recorder plus the runner's own log sink, not from the return value of
`handle_request` and not from a lookup through the GitHub API afterwards.**

| Field | Source |
|---|---|
| `commentUrl` | Recorder around `GithubProvider.publish_comment` / `edit_comment`; the review (or improve summary, or answer) comment is chosen by its hidden marker only: an exact line within the first five lines (or the link-reference form). The visible heading is no identity. An edit counts, which is what every second review does. |
| `ok` | `handle_request` returned `True` **and** the tool did not mark the command as failed **and** no "Failed to ..." comment was posted. A `review` that posted no review comment is also not ok (`review_not_published`). |
| `errorCode` | The exception PR-Agent logged (the runner's loguru sink reads it off the log record) classified by type and cause chain; free text never becomes a code. |
| `durationMs` | Monotonic clock of the runner process, from start until the result is built. |
| `logTail` / `logTruncated` | Own sink, redacted, newest lines, warnings and errors first, at most 4 KB; `logTruncated` says whether the log was longer. |

### Why not `handle_request`

- It returns only `True` or `False`. `True` also means "nothing was posted" (a pull request without
  files, a skipped update, `describe`, which edits the pull request body) and "a tool swallowed its own
  error". 0.47.0 has a silent path (the persistent write fails without an exception) where the tool
  posts "Failed to review PR" and `handle_request` still returns `True`.
- The comment is not returned by any tool: `PRReviewer.run()` returns `None`, and the object returned by
  `publish_persistent_comment_full` is dropped (on an update it is even the separate status comment, not
  the review).
- The control run of CR-11 shows the same: without the identity patch `handle_request` returned
  normally and a different comment was posted.

### Why not the GitHub API afterwards

Tried against a real pull request (below). It works, but it is the weaker design:

- One more request per job, against the rate limit of the installation.
- It has to guess: "the newest comment of the bot after the job start". Two reviews running at once on
  one pull request (two quick pushes), or a failure comment next to the review, make the guess wrong.
  The recorder sees exactly the comment this process wrote.
- The result is the same in the normal case (both paths returned the same URL), so the extra call buys
  nothing. If a PR-Agent upgrade ever breaks the recorder, the unit and engine tests fail first (the
  recorder tests pin the two method signatures and the markers) and the API lookup remains available as
  a fallback to build then.

## Real example (CR-12-T11)

`runner/scripts/manual_review.py --yes --pr-url .../code-reviewer-playground/pull/2`
(`deepseek/deepseek-v3.2`, first review of the medium pull request, usage cost 0.004 USD):

```json
{"ok":true,"durationMs":165465,"commentUrl":"https://github.com/ExpidetGames/code-reviewer-playground/pull/2#issuecomment-6098095542","errorCode":null,"logTail":"INFO Reviewing PR: ... (4 lines)","logTruncated":false,"usage":{"model":"openrouter/deepseek/deepseek-v3.2","promptTokens":7698,"completionTokens":1715,"totalTokens":9413,"aiCalls":1,"fallbackUsed":false,"costUsd":0.0039558}}
```

Second path, for comparison: `GET /repos/ExpidetGames/code-reviewer-playground/issues/2/comments` after the run lists one
comment by `code-reviewer-dev-expidetgames[bot]`, created at 13:41:07Z (job started 13:38:21Z), starting with the
reviewer guide marker: the same URL. Both paths agree here.

## What CR-10 already covered and what this ticket added

| Case | Covered by |
|---|---|
| T01 success with fake clock | New: `test_a_successful_run_reports_the_exact_duration_the_comment_and_a_string_log` (12.5 s gives 12500) |
| T02 unknown exception | New: `test_an_unknown_exception_gives_a_documented_error_code_the_duration_and_no_comment` (3 s gives 3000, code `unknown`; the ticket's `agent_failed` is `unknown` or `command_failed` in the documented set) |
| T03 LLM 429 / 500 / timeout | New at runner level (`test_each_llm_failure_has_its_own_stable_code_and_never_the_raw_message`: `llm_rate_limit`, `llm_unavailable`, `llm_timeout`); the mapping itself was already in `test_error_mapping.py` |
| T04 GitHub 403 / 404 | New at runner level (`git_forbidden`, `pr_not_found`); mapping already tested |
| T05 hanging child, timeout | Already in CR-10 (`test_a_command_that_awaits_too_long...`, watchdog test); added the duration assertion (between 3 s and 20 s) |
| T06 10 MB of log | New: unit (`LogCapture`, 50,000 lines of 200 bytes) and a real process (`flood` scenario: 10 MB through loguru plus 10 MB on stdout and stderr): tail at most 4096 bytes, `logTruncated: true`, stdout stays one short line. Behavior change: new field `logTruncated`. |
| T07 comment link by API | Not applicable by the decision above (recorder). Test that no listing call is made and that `commentUrl` is `null` with `ok: true` for commands other than `review`. |
| T08 secrets in git URL / URL-encoded | New (`x-access-token:TOKEN@` URL, quoted token, Authorization header, key; unit and a real process). The redactor already handled these forms. |
| T09 hostile log text | New (quotes, newlines, escape sequences, embedded `{"ok": true}`; unit and a real process). Behavior change: escape sequences are removed and control characters turned into spaces before redaction, so a log viewer cannot be driven by them and a secret split by an escape sequence is still found. The tests assert on the decoded `logTail`. |
| T10 shared schema in `contracts/` | Not applicable yet: `contracts/` comes with CR-28. The result shape is the one in `runner/README.md`, `ErrorCode` is the single enumeration, and a test pins README and enum together. |
| T11 decision and real example | This document. |

## Rules per command (`ok` and `commentUrl`)

| Command | No comment link |
|---|---|
| `review` | `ok: false`, `review_not_published` (a review that posted nothing, or only PR-Agent's non-authoritative "Standalone PR Review" comment, is a failure the caller must see). This supersedes the earlier lead decision "ok stays true" for `review`; it matches the later CR-41 decision. |
| `improve` | `ok: true`, `commentUrl: null` (no suggestions is a valid outcome). |
| `ask` | `ok: true`, `commentUrl: null` if no answer comment was recorded. |
| `describe` | Always `null`: it edits the pull request itself. |

## Standalone comments (found in the review of this PR)

Without a verified identity PR-Agent 0.47.0 posts the review as a separate comment headed "Standalone PR
Review" (`PRReviewer._as_non_authoritative_review`). It drops the hidden marker but keeps the visible
heading "PR Reviewer Guide". The first version of the recorder also accepted the heading, so such a run
ended `ok: true` with the URL of a comment that "will not replace the canonical review" (this is what the
CR-11 control run did). Now only the marker counts, so the same run ends `ok: false` with
`review_not_published`. Tests: the heading alone is no result, the real standalone body built with PR-Agent's
own function is no result, the canonical body is, the link-reference form of the marker is accepted.

## Follow-ups

- When `contracts/` exists (CR-28): add `logTruncated` to the result schema and validate the results of
  the tests above against it on both sides (CR-12-T10).
- Engine suite (CR-41): the "Standalone PR Review" case against a fake GitHub (unit tests cover it with
  the body PR-Agent 0.47.0 builds).
