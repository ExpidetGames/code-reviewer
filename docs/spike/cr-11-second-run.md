# CR-11 spike: comment update and recognition of earlier findings

Date: 2026-10-10. PR-Agent: `pr-agent==0.47.0`. Model: `deepseek/deepseek-v3.2` through OpenRouter.
Test repository: `ExpidetGames/code-reviewer-playground`, pull request
[#1](https://github.com/ExpidetGames/code-reviewer-playground/pull/1) (branch `pr-small`).
Method: `runner/scripts/manual_review.py --yes` (installation token, runner entry point
`code-reviewer-run-job`, Variante B with the identity patch). Total spend of this spike: about
0.025 USD (a review of this pull request costs 0.003 to 0.005 USD).

## Verdict

| Acceptance criterion | Result |
|---|---|
| The "PR Reviewer Guide" is updated, not posted twice | Passed. A second review edits the existing comment in place, as `code-reviewer-dev-expidetgames[bot]`. |
| Earlier findings are recognized (persistent finding state) | Partly. The state mechanism works, but it only recognizes a finding when the model repeats it word for word. In practice it does not (see below). This is independent of Variante B. |
| Result documented, fallback described if Variante B fails | Done. Variante B did not fail, so no architecture change is proposed. The fallback is described at the end anyway. |

## What was changed in the playground repository

Pull request #1 had one review comment from the CR-10 run, written at commit `ac848ef`. For this
spike one commit was pushed to the branch `pr-small`:

- `75bdbd8` "Return count items from mostExpensiveItems": `src/order.ts`, `slice(0, count - 1)`
  became `slice(0, count)`. This fixes the first planted problem and leaves the second one
  (`summarizeOrder` crashes on an empty order) untouched. Nothing else changed (one line).

No comment was deleted or edited by hand. The commit stays on the branch (a later spike ticket may
restore the original content with a revert commit).

## Runs

All runs were against commit `75bdbd8` unless noted. "Canonical comment" is
[issuecomment-6097473386](https://github.com/ExpidetGames/code-reviewer-playground/pull/1#issuecomment-6097473386),
created by the first review (commit `ac848ef`).

| Run | What | Result |
|---|---|---|
| 1 (CR-10, before) | First review, commit `ac848ef` | Canonical comment created, state with two findings. |
| 2 control | Second review **without** the identity patch | `ok: true`, but a **second, separate comment** [issuecomment-6097957350](https://github.com/ExpidetGames/code-reviewer-playground/pull/1#issuecomment-6097957350) titled "Standalone PR Review". The canonical comment was not touched. |
| 2 | Second review **with** the identity patch | Canonical comment edited in place (`updated_at` changed, `created_at` unchanged, same author), header now says "Review updated until commit 75bdbd8". |
| 3a + 3b | Two reviews started at the same moment | 3b edited the canonical comment. 3a failed with `llm_output_invalid` (the model answered with malformed YAML, unrelated to the concurrency) and PR-Agent posted a separate "Failed to review PR" comment ([issuecomment-6097973813](https://github.com/ExpidetGames/code-reviewer-playground/pull/1#issuecomment-6097973813)). |
| 4a + 4b | Two reviews started at the same moment, again | Both `ok: true`, both report the canonical comment, still exactly one reviewer guide comment. The state of the slower run overwrote the other (last write wins). |

After all runs the pull request has three bot comments: the canonical review, the "Standalone PR
Review" of the control run and one "Failed to review PR". There is one reviewer guide comment that
belongs to the normal flow.

## Findings: how PR-Agent recognizes them (and why it mostly does not)

The first review stored two findings in a hidden marker in the comment (`<!-- pr-agent-review-state:v1`):
`b50ba875c307` (off-by-one in `mostExpensiveItems`) and `bcdf826a1dac` (`summarizeOrder` crashes on an empty
order), both `ACTIVE`.

After the second review (commit `75bdbd8`):

- `b50b...` (off-by-one) is `RESOLVED`. Correct, the commit fixed it.
- `bcdf...` (empty order crash) is also `RESOLVED`, although it is **still in the code**. The model
  reported the same problem again with different words ("Edge Case Bug", id `8e4a7bbf4b9d`), which
  PR-Agent counts as a new finding. The review therefore shows the crash as new and, in the
  "Resolved findings" section, as resolved at the same time.

Why: `finding_id` is the SHA-256 of the file path and the whitespace-normalized, lower-cased text of the
finding (`algo/review_finding_state.py`, `key_issue_fingerprint`). The previous findings are **not** given to the model, so the
model has no reason to repeat its wording. A finding is recognized only if the model produces exactly the
same sentence again; a finding that is not reproduced exactly is marked resolved when the head commit
changed, and added as new otherwise.

Evidence over five reviews that all reported the same problem (`summarizeOrder` on an empty order), none of them
produced an identical text:

| Review | finding id | start of the text |
|---|---|---|
| 1 (`ac848ef`) | `bcdf826a1dac` | "Potential crash on empty order" |
| 2 | `8e4a7bbf4b9d` | "Edge Case Bug" |
| 3b | `e5b40be2c435` | "Possible Issue" |
| 4 (one of two concurrent runs) | `87f0e4f81d92` | "Possible Issue" |
| 2 control (standalone comment, no state) | n/a | "Possible Issue", yet another wording |

Consequences:

- The `ACTIVE` list grows with each run on the same head, because a finding can only be resolved when
  the head commit differs from the commit of the previous run. Runs 2, 3b and 4 on one commit left three
  `ACTIVE` entries for the same problem.
- "Recognized" in the sense of the project decision (a second review does not re-raise findings the
  persistent state already knows) is **not** met for free-text findings from this model. The in-place
  edit part is met.
- This does not depend on how PR-Agent learns its login. The reconcile step is the same code in app
  mode, so the fallback below would not change it.

Ideas to improve recognition (not done here, out of the scope of a spike): ask the model to keep earlier
wording by putting the previous findings into the prompt (needs a PR-Agent change or an
`extra_instructions` workaround), match findings by file and line range instead of by text, or let Code
Reviewer keep its own finding identity in the app. These belong in a separate story.

## Control: does recognition depend on the author login (CR-11-T05)?

Yes. Without the identity patch (the installation token cannot call `GET /user`):

- PR-Agent logs `Could not resolve the GitHub user login: Resource not accessible by integration: 403`
  and `Could not read persistent review state; skipping persistent update, error: GitHub identity
  cannot be verified`.
- It cannot verify that the existing comment is its own, so it does not touch it. It posts the
  review as a new comment headed "Standalone PR Review" instead.
- The runner returned `ok: true` and pointed `commentUrl` at that standalone comment, not at the
  canonical one. With the patch in place this cannot happen, and `pr_agent_version_mismatch` /
  `identity_patch_failed` stop a runner whose patch no longer applies. Follow-up for the
  engine suite: a standalone comment ("Standalone PR Review" header) should not count as the
  result of a review (at least not as `ok` with a `commentUrl`).

With the patch: the canonical comment is found, edited in place, and the finding state is read and
written (run 2 and later).

## Side observations

- A failed review leaves a new "Failed to review PR" comment each time (0.47.0 has no setting to
  suppress it). The runner reports the failure correctly (`ok: false`, `llm_output_invalid`), but the
  pull request collects one such comment per failed run. Worth a follow-up in the runner or a
  note for CR-31 (retries).
- `WARNING Review output failed schema validation` appears in several successful runs. The review is
  still posted; the model output is sometimes not fully schema compliant.
- Duration of a review on this small pull request is 42 to 71 seconds with this model.

## Test cases

| Case | Result |
|---|---|
| CR-11-T01 | Passed manually (runs 2, 3b, 4): one reviewer guide comment, edited in place, content for the new commit, "Review updated until commit". |
| CR-11-T02 | Engine suite (CR-41) will automate this; the real GitHub behavior is shown by run 2. |
| CR-11-T03 | Not passed. The unfixed finding was not recognized as known, it came back with new wording (see above). |
| CR-11-T04 | Passed, with the caveat that any finding the model words differently is also shown as resolved. |
| CR-11-T05 | Done. Recognition depends on the author login (control run), and the patch fixes it. |
| CR-11-T06 | Partly manual (runs 3 and 4 on an existing comment): one comment, no run broke because of the concurrency; the state of one run is lost (last write wins). The race on first creation is for the engine suite. |
| CR-11-T07 | Not run: it needs a deleted comment, and deleting comments was not part of this spike. Engine suite (CR-41). With no existing comment PR-Agent takes the same path as in the first review (run 1 of CR-10). |
| CR-11-T08 | Not run: it needs a comment from another user with the same heading on the pull request. Engine suite (CR-41). |
| CR-11-T09 | Not triggered, see the fallback below. |
| CR-11-T10 | This document. |

## Fallback if Variante B is not enough: upstream app mode

Not needed for the in-place edit; it would not improve finding recognition either. Described for the case
that the identity patch cannot be kept (for example a PR-Agent release that changes `_resolve_user_login`).

1. Give the runner process the GitHub App credentials: `GITHUB__DEPLOYMENT_TYPE=app`,
   `GITHUB__APP_ID`, `GITHUB__PRIVATE_KEY` (the PEM), and put the installation id into the context scope
   of the call (`context["installation_id"]`, an integer).
2. PR-Agent then creates its own installation tokens (`Auth.AppInstallationAuth`) and learns its login
   through `GET /app` with an App JWT (`_resolve_app_login`, returns `<slug>[bot]`). No patch needed. Drop
   `git.token` from the job and the identity patch from the runner.
3. Security consequences: the runner holds the **private key of the GitHub App**, which can mint tokens
   for every installation (every customer), not just for the repository of the job. A compromise of a runner
   process (a malicious repository, a PR-Agent vulnerability) then exposes all installations. With
   Variante B the runner only gets a short-lived token scoped to one repository. In a single-tenant
   setup (one instance, one owner) the exposure is limited to that owner and acceptable; for multi-tenant
   it is not.
4. Recommendation: stay on Variante B (confirmed working). Use app mode only as an emergency exit for
   the patch, and only single-tenant.
