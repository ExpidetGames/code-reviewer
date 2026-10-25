# SPDX-License-Identifier: LicenseRef-Proprietary
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
from .limits import (
    DEFAULT_LIMITS,
    Budget,
    CheckoutError,
    CheckoutMetrics,
    CheckoutReason,
    Limits,
    ObjectUnavailable,
)
from .objects import ObjectStore
from .paths import validate_path
from .protocol import advertisement, fetch_pack
from .repo_skills import is_skill_manifest, neutralize_skill_manifest
from .transport import HttpTransport, Transport, repository_url

_SHA = re.compile(r"[0-9a-f]{40}")


class SkipReason(StrEnum):
    """Stable reason codes for changed content excluded from the review rather than failed.

    `binary` and `too_large` are about the content. The other three are the deny list: a path the
    engine must never be able to read (discovery files, credentials) or a mode that is not a
    regular file. None of them is ever fetched, read or exported, so excluding it exposes nothing;
    the review is told that the file was not reviewed.
    """

    BINARY = "binary"
    TOO_LARGE = "too_large"
    ENGINE_DISCOVERY = "engine_discovery"
    CREDENTIAL_PATH = "credential_path"
    UNSAFE_MODE = "unsafe_mode"


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
    metrics: CheckoutMetrics


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
        raise CheckoutError(CheckoutReason.INVALID_REQUEST)
    url = repository_url(job.base.repository, job.git.base_url)
    pr_parts = job.pr_url.rsplit("/", 4)
    if len(pr_parts) != 5 or "/".join(pr_parts[1:3]) != job.base.repository:
        raise CheckoutError(CheckoutReason.INVALID_REQUEST)
    number = pr_parts[-1]
    if not re.fullmatch(r"[1-9][0-9]{0,8}", number):
        raise CheckoutError(CheckoutReason.INVALID_REQUEST)
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
        raise CheckoutError(CheckoutReason.INVALID_REQUEST)
    budget = budget or Budget(limits, cancelled)
    entries = 0
    omissions: dict[str, Omission] = {}
    skipped: dict[str, Skipped] = {}

    def metrics() -> CheckoutMetrics:
        return _metrics(budget, entries, omissions, skipped)

    # Validate authority fields independently of parse_job: ClaimBase can be constructed directly.
    repository_url(base.repository, "https://api.github.com")
    if not _SHA.fullmatch(base.head_sha) or not 1 <= number <= 999_999_999:
        raise CheckoutError(CheckoutReason.INVALID_REQUEST)
    if (
        not base.base_ref
        or base.base_ref.startswith("-")
        or any(c in base.base_ref for c in " ~^:?*[\\\x00\n\r")
        or ".." in base.base_ref
    ):
        raise CheckoutError(CheckoutReason.INVALID_REQUEST)
    if base.previous_reviewed_sha is not None and not _SHA.fullmatch(base.previous_reviewed_sha):
        raise CheckoutError(CheckoutReason.INVALID_REQUEST)
    budget.charge(4096)
    directory.mkdir(mode=0o700)
    try:
        refs, caps = advertisement(transport, budget)
        if refs.get(f"refs/pull/{number}/head") != base.head_sha:
            raise CheckoutError(CheckoutReason.REF_MOVED)
        base_sha = refs.get(f"refs/heads/{base.base_ref}")
        if base_sha is None:
            raise CheckoutError(CheckoutReason.REF_MISSING)
        store = ObjectStore(directory / "objects", budget)
        # Blobs above the file limit are left out by the server and never transferred. Blobs wanted
        # by name would ignore the filter, so no blob is ever wanted by name.
        blob_limit = limits.file_bytes + 1
        filtered = "filter" in caps
        store.unpack(fetch_pack(transport, base.head_sha, caps, budget, blob_limit=blob_limit))
        head = tracked_tree(store, base.head_sha)
        entries = len(head)
        # The base-to-head ("Files changed") diff is against the merge base, never the moving
        # base-ref snapshot. If the ancestry walk cannot find one within its bound, review the
        # whole head instead of guessing a base.
        merge_base_sha = _resolve_merge_base(
            store, transport, caps, base.head_sha, base_sha, budget, blob_limit
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
                    store.unpack(
                        fetch_pack(
                            transport,
                            base.previous_reviewed_sha,
                            caps,
                            budget,
                            blob_limit=blob_limit,
                        )
                    )
                previous = tracked_tree(store, base.previous_reviewed_sha)
            except ObjectUnavailable:
                budget.check()
                previous = None
        required = changed_paths(head, base_tree)
        if previous is not None:
            required |= changed_paths(head, previous)
        # Per tree (head, base, previous): changed paths whose content is binary or oversized.
        tree_skips: list[dict[str, SkipReason]] = [{}, {}, {}]
        texts: dict[str, str] = {}
        cache: dict[str, str | None] = {}
        # Apply policy to every endpoint, including deleted evidence, before its blob is read.
        for index, tree in enumerate((head, base_tree, previous or {})):
            for path, entry in tree.items():
                budget.check()
                reason = omission_reason(path, entry.mode)
                if redact_text(path, redactor) != path:
                    reason = OmissionReason.CREDENTIAL_PATH
                if reason is None:
                    obj = store.objects.get(entry.oid)
                    if obj is None and filtered:
                        # The size filter left the blob out: it is above the limit and was
                        # never transferred, so its exact size is unknown and not needed.
                        reason = OmissionReason.LARGE_FILE
                    elif obj is None or obj.kind != "blob":
                        raise CheckoutError(CheckoutReason.OBJECT_MISSING)
                    elif obj.size > limits.file_bytes:
                        reason = OmissionReason.LARGE_FILE
                    else:
                        if entry.oid not in cache:
                            cache[entry.oid] = content_text(store.read(entry.oid, "blob"), redactor)
                        text = cache[entry.oid]
                        if text is None:
                            reason = OmissionReason.BINARY
                        elif path in head and head[path] == entry:
                            # A skill manifest reaches the engine only in the form the runner
                            # rewrote (#701). One it cannot rewrite stays in the diff as the text
                            # it is and is left out of the export.
                            exported = (
                                neutralize_skill_manifest(text) if is_skill_manifest(path) else text
                            )
                            if exported is None:
                                omissions[path] = Omission(
                                    redact_text(path, redactor), OmissionReason.INVALID_SKILL
                                )
                            else:
                                texts[path] = exported
                if reason is not None:
                    omissions[path] = Omission(redact_text(path, redactor), reason)
                    if path in required:
                        # A changed file that is binary, oversized, denied or not a regular file
                        # is excluded from the checkout and reported as skipped.
                        tree_skips[index][path] = _skip_reason(reason)
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
        skipped.update(
            {
                path: Skipped(redact_text(path, redactor), reason)
                for path, reason in {**previous_skips, **base_skips}.items()
            }
        )
        metadata = _bounded_text(metadata, budget, redactor)
        prior_state = _bounded_text(prior_state, budget, redactor)
        export = directory / "checkout"
        budget.charge(4096)
        export.mkdir(mode=0o700)
        for path, text in texts.items():
            budget.check()
            raw = text.encode()
            if len(raw) > limits.file_bytes:
                raise CheckoutError(CheckoutReason.INPUT_TOO_LARGE)
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
            raise CheckoutError(CheckoutReason.INPUT_TOO_LARGE)
        budget.charge(len(evidence), exposed=True)
        budget.charge(((len(evidence) + 4095) // 4096) * 4096)
        (directory / "evidence.json").write_bytes(evidence)
        # No fetched object (including an ignored filter's denied blob) survives into the export.
        shutil.rmtree(store.path)
        budget.check()
        final_refs, _ = advertisement(transport, budget)
        if final_refs.get(f"refs/pull/{number}/head") != base.head_sha:
            raise CheckoutError(CheckoutReason.REF_MOVED)
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
            metrics(),
        )
    except (UnicodeError, ValueError):
        shutil.rmtree(directory)
        error = CheckoutError(CheckoutReason.TREE_INVALID)
        error.metrics = metrics()
        raise error from None
    except BaseException as error:
        shutil.rmtree(directory)
        if isinstance(error, CheckoutError) and error.metrics is None:
            error.metrics = metrics()
        raise


def _metrics(
    budget: Budget,
    entries: int,
    omissions: dict[str, Omission],
    skipped: dict[str, Skipped],
) -> CheckoutMetrics:
    omitted: dict[str, int] = {}
    for omission in omissions.values():
        omitted[omission.reason.value] = omitted.get(omission.reason.value, 0) + 1
    skips: dict[str, int] = {}
    for skip in skipped.values():
        skips[skip.reason.value] = skips.get(skip.reason.value, 0) + 1
    return CheckoutMetrics(
        transfer_bytes=budget.transfer,
        preparation_bytes=budget.preparation,
        exposed_bytes=budget.exposed,
        entries=entries,
        omitted=omitted,
        skipped=skips,
    )


def _resolve_merge_base(
    store: ObjectStore,
    transport: Transport,
    capabilities: set[str],
    head: str,
    base_sha: str,
    budget: Budget,
    blob_limit: int,
) -> str | None:
    try:
        found = merge_base(store, transport, capabilities, head, base_sha, budget)
        if found is None or found == head:
            return found
        # The ancestry walk is commits-only; fetch the merge base commit with its tree.
        store.unpack(fetch_pack(transport, found, capabilities, budget, blob_limit=blob_limit))
    except ObjectUnavailable:
        budget.check()
        return None
    return found if found in store.objects else None


def _skip_reason(reason: OmissionReason) -> SkipReason:
    if reason is OmissionReason.LARGE_FILE:
        return SkipReason.TOO_LARGE
    return SkipReason(reason.value)


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
        raise CheckoutError(CheckoutReason.INPUT_TOO_LARGE)
    budget.charge(len(text.encode()))
    return redact_text(text, redactor)


def _parents(path: Path, root: Path, budget: Budget) -> None:
    if path == root or path.exists():
        return
    _parents(path.parent, root, budget)
    budget.charge(4096)
    path.mkdir(mode=0o700)
