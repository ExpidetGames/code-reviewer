# SPDX-License-Identifier: Apache-2.0
"""Prepare exact endpoint evidence and a sanitized per-job tree, without launching an engine."""

import json
import re
import shutil
from collections.abc import Callable
from dataclasses import dataclass
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
from .evidence import Entry, changed_paths, endpoint_diff, tracked_tree
from .limits import DEFAULT_LIMITS, Budget, CheckoutError, Limits, ObjectUnavailable
from .objects import ObjectStore
from .paths import validate_path
from .protocol import advertisement, fetch_pack
from .transport import HttpTransport, Transport, repository_url

_SHA = re.compile(r"[0-9a-f]{40}")


@dataclass(frozen=True)
class Omission:
    path: str
    reason: OmissionReason


@dataclass(frozen=True)
class PreparedContent:
    root: Path
    export: Path
    head_sha: str
    base_sha: str
    previous_sha: str | None
    comparison: str
    files: dict[str, str]
    diff: str
    previous_diff: str
    omissions: tuple[Omission, ...]
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
        if base_sha != base.head_sha:
            store.unpack(fetch_pack(transport, base_sha, caps, budget))
        head = tracked_tree(store, base.head_sha)
        current_base = tracked_tree(store, base_sha)
        previous: dict[str, Entry] | None = None
        if base.comparison == "incremental" and base.previous_reviewed_sha:
            try:
                if base.previous_reviewed_sha not in store.objects:
                    store.unpack(fetch_pack(transport, base.previous_reviewed_sha, caps, budget))
                previous = tracked_tree(store, base.previous_reviewed_sha)
            except ObjectUnavailable:
                budget.check()
                previous = None
        required = changed_paths(head, current_base)
        if previous is not None:
            required |= changed_paths(head, previous)
        omissions: dict[str, Omission] = {}
        texts: dict[str, str] = {}
        cache: dict[str, str | None] = {}
        eligible: set[str] = set()
        prior_eligible: set[str] = set()
        for index, tree in enumerate((head, current_base, previous or {})):
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
            required = changed_paths(head, current_base)
            omissions = {
                path: omission
                for path, omission in omissions.items()
                if path in head or path in current_base
            }
        # Apply policy to every endpoint before any blob reads, including deleted evidence.
        for tree in (head, current_base, previous or {}):
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
                        raise CheckoutError()
        diff = endpoint_diff(current_base, head, cache, budget, redactor)
        previous_diff = (
            endpoint_diff(previous, head, cache, budget, redactor) if previous is not None else ""
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
                "previousReviewedSha": base.previous_reviewed_sha,
                "comparison": "incremental" if previous is not None else "full",
                "denyList": DENY_LIST_VERSION,
                "diff": diff,
                "previousDiff": previous_diff,
                "metadata": metadata,
                "priorState": prior_state,
                "omissions": [x.__dict__ for x in omissions.values()],
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
            base.previous_reviewed_sha,
            "incremental" if previous is not None else "full",
            texts,
            diff,
            previous_diff,
            tuple(omissions.values()),
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
