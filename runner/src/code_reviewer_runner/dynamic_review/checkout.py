# SPDX-License-Identifier: Apache-2.0
"""Prepare exact endpoint evidence and a sanitized per-job tree, without launching an engine."""

import json
import re
import shutil
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

from code_reviewer_runner.job import ClaimBase, Job
from code_reviewer_runner.redaction import Redactor

from .content_policy import (
    DENY_LIST_VERSION,
    OmissionReason,
    content_text,
    omission_reason,
    redact_text,
)
from .evidence import Entry, changed_paths, endpoint_diff, merge_base, tracked_tree
from .limits import DEFAULT_LIMITS, Budget, CheckoutError, Limits, ObjectUnavailable
from .objects import ObjectStore
from .paths import validate_path
from .protocol import advertisement, fetch_pack
from .transport import HttpTransport, Transport, repository_url

_SHA = re.compile(r"[0-9a-f]{40}")


class SkipReason(StrEnum):
    """Stable reason codes for changed content excluded from the review rather than failed."""

    BINARY = "binary"
    TOO_LARGE = "too_large"


@dataclass(frozen=True)
class Omission:
    path: str
    reason: OmissionReason


@dataclass(frozen=True)
class Skipped:
    path: str
    reason: SkipReason


@dataclass(frozen=True)
class PreparedContent:
    root: Path
    export: Path
    head_sha: str
    base_sha: str
    merge_base_sha: str | None
    previous_sha: str | None
    comparison: str
    files: dict[str, str]
    diff: str
    previous_diff: str
    omissions: tuple[Omission, ...]
    skipped: tuple[Skipped, ...]
    metadata: str
    prior_state: str
    deadline: float


def prepare_job_content(
    job: Job,
    directory: Path,
    *,
    limits: Limits = DEFAULT_LIMITS,
    cancelled: Callable[[], bool] = lambda: False,
    metadata: str = "",
    prior_state: str = "",
    budget: Budget | None = None,
) -> PreparedContent:
    if job.base is None or job.git.provider != "github":
        raise CheckoutError()
    url = repository_url(job.base.repository, job.git.base_url)
    pr_parts = job.pr_url.rsplit("/", 4)
    if len(pr_parts) != 5 or "/".join(pr_parts[1:3]) != job.base.repository:
        raise CheckoutError()
    number = pr_parts[-1]
    if not re.fullmatch(r"[1-9][0-9]{0,8}", number):
        raise CheckoutError()
    return prepare_content(
        job.base,
        int(number),
        HttpTransport(url, job.git.token),
        directory,
        Redactor(job.secrets),
        limits=limits,
        cancelled=cancelled,
        metadata=metadata,
        prior_state=prior_state,
        budget=budget,
    )


def prepare_content(
    base: ClaimBase,
    number: int,
    transport: Transport,
    directory: Path,
    redactor: Redactor,
    *,
    limits: Limits = DEFAULT_LIMITS,
    cancelled: Callable[[], bool] = lambda: False,
    metadata: str = "",
    prior_state: str = "",
    budget: Budget | None = None,
) -> PreparedContent:
    """Private trusted intermediate. It is NOT agent-accessible until export isolation seals it.

    The caller owns a fresh directory name under a trusted parent. No shared cache. Failures
    remove that name only; successful lifetime/lease/shutdown cleanup belongs to prepared_job.
    """
    if budget is not None and budget.limits != limits:
        raise CheckoutError()
    budget = budget or Budget(limits, cancelled)
    # Validate authority fields independently of parse_job: ClaimBase can be constructed directly.
    repository_url(base.repository, "https://api.github.com")
    if not _SHA.fullmatch(base.head_sha) or not 1 <= number <= 999_999_999:
        raise CheckoutError()
    if (
        not base.base_ref
        or base.base_ref.startswith("-")
        or any(c in base.base_ref for c in " ~^:?*[\\\x00\n\r")
        or ".." in base.base_ref
    ):
        raise CheckoutError()
    if base.previous_reviewed_sha is not None and not _SHA.fullmatch(base.previous_reviewed_sha):
        raise CheckoutError()
    budget.charge(4096)
    directory.mkdir(mode=0o700)
    try:
        refs, caps = advertisement(transport, budget)
        if refs.get(f"refs/pull/{number}/head") != base.head_sha:
            raise CheckoutError()
        base_sha = refs.get(f"refs/heads/{base.base_ref}")
        if base_sha is None:
            raise CheckoutError()
        store = ObjectStore(directory / "objects", budget)
        store.unpack(fetch_pack(transport, base.head_sha, caps, budget))
        head = tracked_tree(store, base.head_sha)
        # The base-to-head ("Files changed") diff is against the merge base, never the moving
        # base-ref snapshot. If the ancestry walk cannot find one within its bound, review the
        # whole head instead of guessing a base.
        merge_base_sha = _resolve_merge_base(
            store, transport, caps, base.head_sha, base_sha, budget
        )
        base_tree: dict[str, Entry] = {}
        if merge_base_sha is not None:
            base_tree = tracked_tree(store, merge_base_sha)
        previous: dict[str, Entry] | None = None
        # A claim whose attempted-heads list was cut (#257) is always a full review: the summary
        # may be rewritten from scratch, so a diff against the last review would show a part only.
        if (
            base.comparison == "incremental"
            and base.previous_reviewed_sha
            and not base.attempted_shas_truncated
        ):
            try:
                if base.previous_reviewed_sha not in store.objects:
                    store.unpack(fetch_pack(transport, base.previous_reviewed_sha, caps, budget))
                previous = tracked_tree(store, base.previous_reviewed_sha)
            except ObjectUnavailable:
                budget.check()
                previous = None
        required = changed_paths(head, base_tree)
        if previous is not None:
            required |= changed_paths(head, previous)
        omissions: dict[str, Omission] = {}
        # Per tree (head, base, previous): changed paths whose content is binary or oversized.
        tree_skips: list[dict[str, SkipReason]] = [{}, {}, {}]
        texts: dict[str, str] = {}
        cache: dict[str, str | None] = {}
        eligible: set[str] = set()
        prior_eligible: set[str] = set()
        for index, tree in enumerate((head, base_tree, previous or {})):
            for path, entry in tree.items():
                budget.check()
                reason = omission_reason(path, entry.mode)
                if redact_text(path, redactor) != path:
                    reason = OmissionReason.CREDENTIAL_PATH
                if reason is not None:
                    omissions[path] = Omission(redact_text(path, redactor), reason)
                    if path in required:
                        raise CheckoutError()
                    continue
                if entry.oid not in store.objects:
                    (eligible if index < 2 else prior_eligible).add(entry.oid)

        def hydrate(oids: set[str]) -> None:
            missing = sorted(oids - store.objects.keys())
            for offset in range(0, len(missing), 32):
                store.unpack(
                    fetch_pack(
                        transport, tuple(missing[offset : offset + 32]), caps, budget, blobs=True
                    )
                )

        hydrate(eligible)
        try:
            hydrate(prior_eligible)
        except ObjectUnavailable:
            budget.check()
            previous = None
            required = changed_paths(head, base_tree)
            omissions = {
                path: omission
                for path, omission in omissions.items()
                if path in head or path in base_tree
            }
        # Apply policy to every endpoint before any blob reads, including deleted evidence.
        for index, tree in enumerate((head, base_tree, previous or {})):
            for path, entry in tree.items():
                budget.check()
                reason = omission_reason(path, entry.mode)
                if redact_text(path, redactor) != path:
                    reason = OmissionReason.CREDENTIAL_PATH
                if reason is None:
                    obj = store.objects.get(entry.oid)
                    if obj is None or obj.kind != "blob":
                        raise CheckoutError()
                    if obj.size > limits.file_bytes:
                        reason = OmissionReason.LARGE_FILE
                    else:
                        if entry.oid not in cache:
                            cache[entry.oid] = content_text(store.read(entry.oid, "blob"), redactor)
                        text = cache[entry.oid]
                        if text is None:
                            reason = OmissionReason.BINARY
                        elif path in head and head[path] == entry:
                            texts[path] = text
                if reason is not None:
                    omissions[path] = Omission(redact_text(path, redactor), reason)
                    if path in required:
                        # A changed binary or oversized file is excluded from the checkout and
                        # reported as skipped; denied or unsafe content still fails closed.
                        skip_reason = _skip_reason(reason)
                        if skip_reason is None:
                            raise CheckoutError()
                        tree_skips[index][path] = skip_reason
        # Classify per comparison: a path is skipped in a diff only when one of that diff's two
        # sides is binary or oversized, so a third revision cannot hide a text change.
        base_skips = _pair_skips(head, base_tree, tree_skips[0], tree_skips[1])
        previous_skips = (
            _pair_skips(head, previous, tree_skips[0], tree_skips[2])
            if previous is not None
            else {}
        )
        diff = endpoint_diff(
            _diffable(base_tree, base_skips), _diffable(head, base_skips), cache, budget, redactor
        )
        previous_diff = (
            endpoint_diff(
                _diffable(previous, previous_skips),
                _diffable(head, previous_skips),
                cache,
                budget,
                redactor,
            )
            if previous is not None
            else ""
        )
        skipped = {
            path: Skipped(redact_text(path, redactor), reason)
            for path, reason in {**previous_skips, **base_skips}.items()
        }
        metadata = _bounded_text(metadata, budget, redactor)
        prior_state = _bounded_text(prior_state, budget, redactor)
        export = directory / "checkout"
        budget.charge(4096)
        export.mkdir(mode=0o700)
        for path, text in texts.items():
            budget.check()
            raw = text.encode()
            if len(raw) > limits.file_bytes:
                raise CheckoutError()
            budget.charge(len(raw), exposed=True)
            target = export.joinpath(*validate_path(path, limits))
            _parents(target.parent, export, budget)
            budget.charge(((len(raw) + 4095) // 4096) * 4096)
            target.write_bytes(raw)
        evidence = json.dumps(
            {
                "headSha": base.head_sha,
                "baseSha": base_sha,
                "mergeBaseSha": merge_base_sha,
                "previousReviewedSha": base.previous_reviewed_sha,
                "comparison": "incremental" if previous is not None else "full",
                "denyList": DENY_LIST_VERSION,
                "diff": diff,
                "previousDiff": previous_diff,
                "metadata": metadata,
                "priorState": prior_state,
                "omissions": [x.__dict__ for x in omissions.values()],
                "skipped": [x.__dict__ for x in skipped.values()],
            },
            ensure_ascii=True,
        ).encode()
        if len(evidence) > limits.diff_bytes + limits.response_bytes:
            raise CheckoutError()
        budget.charge(len(evidence), exposed=True)
        budget.charge(((len(evidence) + 4095) // 4096) * 4096)
        (directory / "evidence.json").write_bytes(evidence)
        # No fetched object (including an ignored filter's denied blob) survives into the export.
        shutil.rmtree(store.path)
        budget.check()
        final_refs, _ = advertisement(transport, budget)
        if final_refs.get(f"refs/pull/{number}/head") != base.head_sha:
            raise CheckoutError()
        return PreparedContent(
            directory,
            export,
            base.head_sha,
            base_sha,
            merge_base_sha,
            base.previous_reviewed_sha,
            "incremental" if previous is not None else "full",
            texts,
            diff,
            previous_diff,
            tuple(omissions.values()),
            tuple(skipped.values()),
            metadata,
            prior_state,
            budget.deadline,
        )
    except (UnicodeError, ValueError):
        shutil.rmtree(directory)
        raise CheckoutError() from None
    except BaseException:
        shutil.rmtree(directory)
        raise


def _resolve_merge_base(
    store: ObjectStore,
    transport: Transport,
    capabilities: set[str],
    head: str,
    base_sha: str,
    budget: Budget,
) -> str | None:
    try:
        found = merge_base(store, transport, capabilities, head, base_sha, budget)
        if found is None or found == head:
            return found
        # The ancestry walk is commits-only; fetch the merge base commit with its tree.
        store.unpack(fetch_pack(transport, found, capabilities, budget))
    except ObjectUnavailable:
        budget.check()
        return None
    return found if found in store.objects else None


def _skip_reason(reason: OmissionReason) -> SkipReason | None:
    if reason is OmissionReason.BINARY:
        return SkipReason.BINARY
    if reason is OmissionReason.LARGE_FILE:
        return SkipReason.TOO_LARGE
    return None


def _pair_skips(
    left: dict[str, Entry],
    right: dict[str, Entry],
    left_skips: dict[str, SkipReason],
    right_skips: dict[str, SkipReason],
) -> dict[str, SkipReason]:
    return {
        path: left_skips.get(path) or right_skips[path]
        for path in changed_paths(left, right)
        if path in left_skips or path in right_skips
    }


def _diffable(tree: dict[str, Entry], skipped: dict[str, SkipReason]) -> dict[str, Entry]:
    return {path: entry for path, entry in tree.items() if path not in skipped}


def _bounded_text(text: str, budget: Budget, redactor: Redactor) -> str:
    if len(text.encode()) > budget.limits.response_bytes:
        raise CheckoutError()
    budget.charge(len(text.encode()))
    return redact_text(text, redactor)


def _parents(path: Path, root: Path, budget: Budget) -> None:
    if path == root or path.exists():
        return
    _parents(path.parent, root, budget)
    budget.charge(4096)
    path.mkdir(mode=0o700)
