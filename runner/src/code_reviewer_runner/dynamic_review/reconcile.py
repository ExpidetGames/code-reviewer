# SPDX-License-Identifier: Apache-2.0

"""Reconciles a Dynamic Review run with the state of the earlier runs (#199).

The rules are the fixed core's, enforced here on untrusted model output:

- a previous finding is resolved **only** when this run names its id in `resolvedIds`; an omitted,
  unreadable or limit-blocked previous finding stays active — resolution by absence is impossible;
- the id of a finding is stable across line shifts and rephrasing: a run finding that re-raises a
  known finding keeps its id, and a run finding that repeats an active finding's path and title
  under a new id is folded into the known one instead of becoming a duplicate;
- a finding that comes back after it was resolved is re-opened (it is active again, and it is not
  listed twice under Resolved findings);
- the resolved history is retained losslessly, in order; it is never pruned to a cap.

Reconciliation is deterministic and pure: the same state and run always give the same state.
"""

from dataclasses import replace

from code_reviewer_runner.dynamic_findings import DynamicFindings, Finding
from code_reviewer_runner.dynamic_review.state import ResolvedFinding, ReviewState, empty_state


def identity_of(finding: Finding) -> tuple[str, str]:
    """The content key a re-raised finding keeps across a line shift or a rephrasing.

    The opaque model id is authoritative when it matches; this fallback catches the case where the
    model lost an id. Path and title are case- and whitespace-normalized; the line range is not part
    of it, so moving a finding does not change its identity.
    """
    return (finding.path.casefold(), " ".join(finding.title.split()).casefold())


def reconcile(previous: ReviewState | None, run: DynamicFindings) -> ReviewState:
    """The state after this run: active findings, resolved history and the new reviewed head."""
    prior = previous if previous is not None else empty_state()
    prior_active = {finding.id: finding for finding in prior.findings}
    prior_resolved = {entry.finding.id: entry for entry in prior.resolved}
    run_ids = {finding.id for finding in run.findings}

    # Affirmative resolutions only: a named id that really is active. Naming an id that is still
    # reported (a contradiction) or one that never existed does nothing.
    resolved_ids = [
        finding_id
        for finding_id in run.resolved_ids
        if finding_id in prior_active and finding_id not in run_ids
    ]
    resolved_set = set(resolved_ids)

    active: list[Finding] = []
    claimed_prior: set[str] = set()
    seen_ids: set[str] = set()
    seen_keys: set[tuple[str, str]] = set()
    reopened: set[str] = set()

    for finding in run.findings:
        if finding.id in seen_ids:
            continue
        if finding.id in prior_active:
            active.append(finding)
            claimed_prior.add(finding.id)
        elif finding.id in prior_resolved:
            active.append(finding)
            reopened.add(finding.id)
        else:
            key = identity_of(finding)
            known = _known_by_identity(
                finding, prior_active, claimed_prior, resolved_set, seen_keys
            )
            if known is not None:
                # Keep the stable id the earlier run gave the finding.
                active.append(replace(finding, id=known.id))
                claimed_prior.add(known.id)
            elif key in seen_keys:
                continue  # a duplicate the model raised twice in one run
            else:
                active.append(finding)
        seen_ids.add(active[-1].id)
        seen_keys.add(identity_of(active[-1]))

    # A previous finding that this run did not name stays active, unchanged. This is the rule that
    # forbids resolution by absence; the run may have been incremental and simply not seen it.
    for finding_id, finding in prior_active.items():
        if finding_id in claimed_prior or finding_id in resolved_set:
            continue
        active.append(finding)
        seen_ids.add(finding_id)

    resolved: list[ResolvedFinding] = [
        entry for entry in prior.resolved if entry.finding.id not in reopened
    ]
    already = {entry.finding.id for entry in resolved}
    for finding_id in resolved_ids:
        if finding_id in already:
            continue
        resolved.append(
            ResolvedFinding(finding=prior_active[finding_id], resolved_sha=run.reviewed_sha)
        )
        already.add(finding_id)

    return ReviewState(
        reviewed_sha=run.reviewed_sha,
        findings=tuple(active),
        resolved=tuple(resolved),
        omitted_findings=prior.omitted_findings,
    )


def _known_by_identity(
    finding: Finding,
    prior_active: dict[str, Finding],
    claimed_prior: set[str],
    resolved_set: set[str],
    seen_keys: set[tuple[str, str]],
) -> Finding | None:
    key = identity_of(finding)
    if key in seen_keys:
        return None
    for candidate in prior_active.values():
        if candidate.id in claimed_prior or candidate.id in resolved_set:
            continue
        if identity_of(candidate) == key:
            return candidate
    return None


def summary_counts(findings: tuple[Finding, ...]) -> dict[str, int]:
    """How many active findings of each priority, P0 first. The renderer's headline."""
    counts = {"P0": 0, "P1": 0, "P2": 0, "P3": 0}
    for finding in findings:
        counts[finding.priority] += 1
    return counts
