# SPDX-License-Identifier: Apache-2.0
"""Trusted preparation against real local Git objects, never GitHub or a model."""

import os
import sys
from dataclasses import replace
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.dynamic_git.fixtures import GitFixture, git

from code_reviewer_runner.dynamic_review.checkout import prepare_content
from code_reviewer_runner.dynamic_review.limits import CheckoutError, CheckoutReason, Limits
from code_reviewer_runner.dynamic_review.transport import LocalTransport
from code_reviewer_runner.job import ClaimBase
from code_reviewer_runner.redaction import Redactor


@pytest.fixture
def repo(tmp_path: Path) -> GitFixture:
    return GitFixture(tmp_path / "base.git")


def claim(repo: GitFixture, previous: str | None = None) -> ClaimBase:
    return ClaimBase(
        "owner/base", "main", repo.head, previous, "incremental" if previous else "full"
    )


# #196-T01
@pytest.mark.parametrize("fork", [False, True])
def test_exact_head_and_sanitized_evidence_are_prepared(
    repo: GitFixture, tmp_path: Path, fork: bool
) -> None:
    if fork:
        fork_repo = GitFixture(tmp_path / "fork.git")
        fork_head = fork_repo.set_head({"README.md": b"fork\n"}, orphan=True)
        git(
            repo.path,
            "fetch",
            "--no-tags",
            fork_repo.path.as_uri(),
            f"+{fork_head}:refs/pull/196/head",
        )
        repo.head = fork_head
    result = prepare_content(
        claim(repo), 196, LocalTransport(repo.path), tmp_path / "job", Redactor(("dummy-secret",))
    )
    assert result.head_sha == repo.head and result.base_sha == repo.base
    assert "README.md" in result.files
    assert result.diff
    assert not any(p.name == ".git" for p in (tmp_path / "job").rglob("*"))
    assert result.comparison == "full"


# #196-T01 #196-T12
@pytest.mark.parametrize("chunked", [False, True])
def test_a_large_eligible_blob_survives_download_and_inflation(
    repo: GitFixture, tmp_path: Path, chunked: bool
) -> None:
    from fakes.dynamic_git.server import git_server

    from code_reviewer_runner.dynamic_review.transport import HttpTransport

    payload = b"a" * 200_000
    repo.set_head({"README.md": b"base\n", "big.txt": payload, "x.txt": b"x\n"})
    git(repo.path, "update-ref", "refs/heads/main", repo.head)
    with git_server(repo.path) as server:
        server.chunked = chunked
        result = prepare_content(
            claim(repo),
            196,
            HttpTransport(server.url, server.token),
            tmp_path / "job",
            Redactor((server.token,)),
        )
    assert result.files["big.txt"] == payload.decode()
    assert result.files["x.txt"] == "x\n"


# #196-T01 #196-T12
def test_a_large_eligible_blob_is_hydrated_through_real_git_transfer(
    repo: GitFixture, tmp_path: Path
) -> None:
    # The local real-Git path is what the review used to expose the mis-tracked stream end.
    payload = b"a" * 200_000
    repo.set_head({"README.md": b"base\n", "big.txt": payload, "x.txt": b"x\n", "y.txt": b"y\n"})
    git(repo.path, "update-ref", "refs/heads/main", repo.head)
    result = prepare_content(
        claim(repo), 196, LocalTransport(repo.path), tmp_path / "job", Redactor(())
    )
    assert result.files["big.txt"] == payload.decode()
    assert {"big.txt", "x.txt", "y.txt"} <= set(result.files)


# #196-T03 #196-T10
def test_discovery_credentials_and_symlinks_are_not_read_or_relocated(
    repo: GitFixture, tmp_path: Path
) -> None:
    repo.set_head(
        {
            "README.md": b"base\n",
            "safe.txt": b"source\n",
            "AGENTS.md": b"untrusted rules\n",
            ".opencode/plugins/evil.js": b"payload-sentinel",
            "opencode.json": b"payload-sentinel",
            ".env.local": b"secret-sentinel",
            "link": ("120000", b"/etc/passwd"),
        }
    )
    git(repo.path, "update-ref", "refs/heads/main", repo.head)
    result = prepare_content(
        claim(repo), 196, LocalTransport(repo.path), tmp_path / "job", Redactor(())
    )
    assert set(result.files) == {"README.md", "safe.txt", "AGENTS.md"}
    assert {x.reason for x in result.omissions} == {
        "engine_discovery",
        "credential_path",
        "unsafe_mode",
    }
    assert not any(
        b"sentinel" in p.read_bytes() for p in (tmp_path / "job").rglob("*") if p.is_file()
    )


# #196-T04 #196-T10
@pytest.mark.parametrize(
    "name,value",
    [
        ("opencode.json", b"{}"),
        (".env.local", b"secret"),
        ("link", ("120000", b"/etc/passwd")),
    ],
)
def test_required_denied_or_unsafe_changes_fail_the_review(
    repo: GitFixture, tmp_path: Path, name: str, value: bytes | tuple[str, bytes]
) -> None:
    repo.set_head({"README.md": b"base\n", name: value})
    with pytest.raises(CheckoutError, match="checkout_incomplete"):
        prepare_content(claim(repo), 196, LocalTransport(repo.path), tmp_path / "job", Redactor(()))
    assert not (tmp_path / "job").exists()


# #196-T04 #196-T05
@pytest.mark.parametrize(
    "name,value,reason",
    [("image.bin", b"\0", "binary"), ("large.txt", b"a" * 17, "too_large")],
)
def test_changed_binary_or_oversized_files_are_skipped_not_failed(
    repo: GitFixture, tmp_path: Path, name: str, value: bytes, reason: str
) -> None:
    import json

    repo.set_head({"README.md": b"base\n", name: value})
    result = prepare_content(
        claim(repo),
        196,
        LocalTransport(repo.path),
        tmp_path / "job",
        Redactor(()),
        limits=Limits(file_bytes=16),
    )
    assert name not in result.files
    assert [(skip.path, skip.reason) for skip in result.skipped] == [(name, reason)]
    assert name not in result.diff
    evidence = json.loads((result.root / "evidence.json").read_bytes())
    assert {"path": name, "reason": reason} in evidence["skipped"]


# #196-T07
@pytest.mark.parametrize("deleted", [False, True])
def test_stale_or_removed_heads_never_review_a_newer_sha(
    repo: GitFixture, tmp_path: Path, deleted: bool
) -> None:
    old = claim(repo)
    if deleted:
        git(repo.path, "update-ref", "-d", "refs/pull/196/head")
    else:
        repo.set_head({"README.md": b"new\n"})
    with pytest.raises(CheckoutError):
        prepare_content(old, 196, LocalTransport(repo.path), tmp_path / "job", Redactor(()))
    assert not (tmp_path / "job").exists()


# #196-T11
def test_orphan_heads_compare_exact_endpoint_trees_with_rename_and_delete(
    repo: GitFixture, tmp_path: Path
) -> None:
    previous = repo.head
    git(repo.path, "update-ref", "refs/heads/previous", previous)
    repo.set_head({"renamed.py": b"print('review')\n"}, orphan=True)
    result = prepare_content(
        claim(repo, previous),
        196,
        LocalTransport(repo.path),
        tmp_path / "job",
        Redactor(()),
        prior_state="prior-findings",
    )
    assert result.comparison == "incremental"
    assert result.previous_sha == previous
    assert "source.py" in result.previous_diff and "renamed.py" in result.previous_diff
    assert result.prior_state == "prior-findings"


# #257-T04
def test_a_truncated_claim_is_a_full_review_whatever_comparison_it_declares(
    repo: GitFixture, tmp_path: Path
) -> None:
    previous = repo.head
    git(repo.path, "update-ref", "refs/heads/previous", previous)
    repo.set_head({"renamed.py": b"print('review')\n"}, orphan=True)
    result = prepare_content(
        replace(claim(repo, previous), attempted_shas_truncated=True),
        196,
        LocalTransport(repo.path),
        tmp_path / "job",
        Redactor(()),
    )
    assert result.comparison == "full"
    assert result.previous_diff == ""


# #196-T07 #196-T11
def test_unavailable_prior_tree_declares_full_mode_and_retains_findings(
    repo: GitFixture, tmp_path: Path
) -> None:
    result = prepare_content(
        claim(repo, "a" * 40),
        196,
        LocalTransport(repo.path),
        tmp_path / "job",
        Redactor(()),
        prior_state="prior-findings",
    )
    assert result.comparison == "full" and result.previous_diff == ""
    assert result.prior_state == "prior-findings"


# #196-T04 #196-T12
@pytest.mark.parametrize(
    "changes",
    [
        {"entries": 1},
        {"exposed_bytes": 1},
        {"diff_bytes": 1},
        {"preparation_bytes": 1},
        {"response_bytes": 1},
    ],
)
def test_global_quotas_fail_and_remove_only_the_owned_directory(
    repo: GitFixture, tmp_path: Path, changes: dict[str, int]
) -> None:
    other = tmp_path / "other"
    other.mkdir()
    (other / "sentinel").write_text("keep")
    with pytest.raises(CheckoutError):
        prepare_content(
            claim(repo),
            196,
            LocalTransport(repo.path),
            tmp_path / "job",
            Redactor(()),
            metadata="xx",
            limits=replace(Limits(), **changes),
        )
    assert not (tmp_path / "job").exists() and (other / "sentinel").read_text() == "keep"


# #196-T12
@pytest.mark.parametrize("filtering", [True, False])
def test_huge_deferred_blobs_and_ignored_filters_cannot_expand_past_quota(
    tmp_path: Path, filtering: bool
) -> None:
    repo = GitFixture(tmp_path / "base.git", filtering=filtering)
    repo.set_head({"large.txt": b"x" * 1_000_000})
    with pytest.raises(CheckoutError):
        prepare_content(
            claim(repo),
            196,
            LocalTransport(repo.path),
            tmp_path / "job",
            Redactor(()),
            limits=Limits(preparation_bytes=64 * 1024),
        )
    assert not (tmp_path / "job").exists()


# #196-T06 #196-T08
def test_an_actual_agent_user_cannot_mutate_exports_or_read_parent_and_other_jobs(
    repo: GitFixture,
) -> None:
    import os
    import subprocess

    probe = Path(__file__).with_name("checkout_isolation_probe.py")
    command = [
        sys.executable,
        "-I",
        str(probe),
        str(Path(__file__).resolve().parents[2] / "src"),
        str(repo.path),
        repo.head,
        repo.base,
    ]
    if os.getuid() != 0:
        command = ["sudo", "-n", *command]
    outcome = subprocess.run(command, capture_output=True, text=True, timeout=20)
    assert outcome.returncode == 0, outcome.stderr
    assert '"isolation": "passed"' in outcome.stdout


# #196-T07 #196-T11
def test_a_corrupt_prior_transfer_cannot_be_relabeled_as_a_full_review(
    repo: GitFixture, tmp_path: Path
) -> None:
    from collections.abc import Generator

    from code_reviewer_runner.dynamic_review.limits import Budget

    class BrokenPrior(LocalTransport):
        def stream(self, request: bytes | None, budget: Budget) -> Generator[bytes]:
            if request is not None and ("a" * 40).encode() in request:
                yield b"0009bogus"
                return
            yield from super().stream(request, budget)

    with pytest.raises(CheckoutError):
        prepare_content(
            claim(repo, "a" * 40), 196, BrokenPrior(repo.path), tmp_path / "job", Redactor(())
        )


# #196-T07
def test_a_head_changed_during_preparation_is_refused(repo: GitFixture, tmp_path: Path) -> None:
    from collections.abc import Generator

    from code_reviewer_runner.dynamic_review.limits import Budget

    class RacingHead(LocalTransport):
        advertisements = 0

        def stream(self, request: bytes | None, budget: Budget) -> Generator[bytes]:
            if request is None:
                self.advertisements += 1
                if self.advertisements == 2:
                    repo.set_head({"new.txt": b"new"})
            yield from super().stream(request, budget)

    with pytest.raises(CheckoutError):
        prepare_content(claim(repo), 196, RacingHead(repo.path), tmp_path / "job", Redactor(()))


# #196-T01 #196-T05
def test_installation_authentication_stays_in_http_and_the_base_repository(
    repo: GitFixture, tmp_path: Path
) -> None:
    from fakes.dynamic_git.server import git_server

    from code_reviewer_runner.dynamic_review.transport import HttpTransport

    with git_server(repo.path) as server:
        result = prepare_content(
            claim(repo),
            196,
            HttpTransport(server.url, server.token),
            tmp_path / "job",
            Redactor((server.token,)),
            metadata=f"title {server.token}",
            prior_state=f"old {server.token}",
        )
        assert result.head_sha == repo.head
        assert all(path.startswith("/owner/base.git/") for path, _ in server.requests)
        assert all(server.token.encode() not in request for _, request in server.requests)
        assert not any(
            server.token.encode() in p.read_bytes() for p in result.root.rglob("*") if p.is_file()
        )


# #196-T07
@pytest.mark.parametrize(
    "status,code",
    [
        (401, "git_auth"),
        (403, "git_forbidden"),
        (404, "pr_not_found"),
        (429, "git_rate_limit"),
        (503, "git_unavailable"),
    ],
)
def test_provider_failures_have_stable_codes_without_response_content(
    repo: GitFixture, tmp_path: Path, status: int, code: str
) -> None:
    from fakes.dynamic_git.server import git_server

    from code_reviewer_runner.dynamic_review.transport import HttpTransport

    with git_server(repo.path) as server:
        server.status = status
        with pytest.raises(CheckoutError) as failure:
            prepare_content(
                claim(repo),
                196,
                HttpTransport(server.url, server.token),
                tmp_path / "job",
                Redactor((server.token,)),
            )
        assert failure.value.code.value == code
        assert str(failure.value) == code
        assert len(server.requests) == 1
    assert not (tmp_path / "job").exists()


# #196-T08
def test_a_blocked_fetch_obeys_the_whole_preparation_deadline(
    repo: GitFixture, tmp_path: Path
) -> None:
    from fakes.dynamic_git.server import git_server

    from code_reviewer_runner.dynamic_review.transport import HttpTransport

    with git_server(repo.path) as server:
        server.stall = True
        with pytest.raises(CheckoutError, match="timeout"):
            prepare_content(
                claim(repo),
                196,
                HttpTransport(server.url, server.token),
                tmp_path / "job",
                Redactor(()),
                limits=Limits(seconds=0.1),
            )
    assert not (tmp_path / "job").exists()


# #196-T08
def test_supervision_kills_blocked_preparation_and_helpers_and_removes_only_its_job(
    repo: GitFixture,
) -> None:
    import asyncio
    import json
    import os

    from fakes.dynamic_git.server import git_server

    from code_reviewer_runner.job_loop.process import ProcessSpec, SubprocessLauncher

    async def scenario() -> None:
        script = Path(__file__).resolve().parents[3] / "fakes/dynamic_git/prepare_job.py"
        source = Path(__file__).resolve().parents[2] / "src"
        with git_server(repo.path) as server:
            server.stall = True
            launcher = SubprocessLauncher(terminate_grace=0.1)
            spec = ProcessSpec(
                (sys.executable, "-I", str(script), str(source)),
                {"PATH": os.defpath},
                json.dumps({"head": repo.head, "url": server.url, "token": server.token}).encode(),
            )
            process = await launcher.start(spec)
            other = await launcher.start(
                ProcessSpec(
                    (sys.executable, "-I", "-c", "import signal; signal.pause()"),
                    {"PATH": os.defpath},
                    b"",
                )
            )
            try:
                assert await asyncio.to_thread(server.entered.wait, 5)
                await process.terminate()
                outcome = await process.wait()
                info = json.loads(outcome.stdout)
                assert outcome.exit_code < 0
                assert not Path(info["directory"]).exists()
                for pid in (info["leader"], info["helper"]):
                    status = Path(f"/proc/{pid}/stat")
                    assert not status.exists() or status.read_text().split()[2] == "Z"
                # The unrelated job remains live until its own explicit termination below.
                wait = asyncio.create_task(other.wait())
                assert not wait.done()
                wait.cancel()
            finally:
                await process.terminate()
                await other.terminate()

    asyncio.run(scenario())


# #196-T03 #196-T10
def test_discovery_and_credential_blobs_are_neither_hydrated_nor_read(
    repo: GitFixture, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from collections.abc import Generator

    from code_reviewer_runner.dynamic_review.limits import Budget
    from code_reviewer_runner.dynamic_review.objects import ObjectStore

    payload = b"never-read-this-payload"
    repo.set_head(
        {"README.md": b"base\n", ".opencode/plugin/evil.js": payload, ".env.private": payload}
    )
    git(repo.path, "update-ref", "refs/heads/main", repo.head)
    denied = git(repo.path, "hash-object", "--stdin", data=payload).decode().strip()
    read_blobs: list[str] = []
    requested: list[bytes] = []
    original = ObjectStore.read

    def read(store: ObjectStore, oid: str, kind: str) -> bytes:
        if kind == "blob":
            read_blobs.append(oid)
        return original(store, oid, kind)

    class TrackingTransport(LocalTransport):
        def stream(self, request: bytes | None, budget: Budget) -> Generator[bytes]:
            if request is not None:
                requested.append(request)
            yield from super().stream(request, budget)

    monkeypatch.setattr(ObjectStore, "read", read)
    result = prepare_content(
        claim(repo), 196, TrackingTransport(repo.path), tmp_path / "job", Redactor(())
    )
    assert denied not in read_blobs
    assert all(denied.encode() not in request for request in requested)
    assert set(result.files) == {"README.md"}


# #196-T03
def test_repository_filters_hooks_submodules_lfs_and_inherited_git_settings_do_not_execute(
    repo: GitFixture, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sentinel = tmp_path / "executed"
    script = tmp_path / "malicious.sh"
    script.write_text(f"#!/bin/sh\ntouch '{sentinel}'\n")
    script.chmod(0o755)
    git(repo.path, "config", "filter.evil.smudge", str(script))
    git(repo.path, "config", "filter.evil.required", "true")
    (repo.path / "hooks/post-checkout").write_bytes(script.read_bytes())
    (repo.path / "hooks/post-checkout").chmod(0o755)
    monkeypatch.setenv("GIT_CONFIG_COUNT", "1")
    monkeypatch.setenv("GIT_CONFIG_KEY_0", "credential.helper")
    monkeypatch.setenv("GIT_CONFIG_VALUE_0", str(script))
    monkeypatch.setenv("GIT_ALTERNATE_OBJECT_DIRECTORIES", str(tmp_path / "outside"))
    monkeypatch.setenv("GIT_SSH_COMMAND", str(script))
    repo.set_head(
        {
            "README.md": b"base\n",
            ".gitattributes": b"*.txt filter=evil\n",
            ".gitmodules": b'[submodule "evil"]\nurl=https://example.invalid\n',
            "source.txt": (
                b"version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 9999999999\n"
            ),
            "link": ("120000", str(sentinel).encode()),
        }
    )
    git(repo.path, "update-ref", "refs/heads/main", repo.head)
    result = prepare_content(
        claim(repo), 196, LocalTransport(repo.path), tmp_path / "job", Redactor(())
    )
    assert not sentinel.exists()
    assert "link" not in result.files
    assert result.files["source.txt"].startswith("version https://git-lfs")


# #196-T04
@pytest.mark.parametrize("delta", [0, 1])
def test_file_size_limit_accepts_exact_and_omits_one_over_when_unchanged(
    repo: GitFixture, tmp_path: Path, delta: int
) -> None:
    repo.set_head({"README.md": b"base\n", "sized.txt": b"x" * (16 + delta)})
    git(repo.path, "update-ref", "refs/heads/main", repo.head)
    result = prepare_content(
        claim(repo),
        196,
        LocalTransport(repo.path),
        tmp_path / "job",
        Redactor(()),
        limits=Limits(file_bytes=16),
    )
    assert ("sized.txt" in result.files) == (delta == 0)
    assert (len(result.omissions) == 1) == (delta == 1)


# #196-T04
@pytest.mark.parametrize("delta", [0, 1])
def test_tree_entry_limit_accepts_exact_and_refuses_one_over(
    repo: GitFixture, tmp_path: Path, delta: int
) -> None:
    repo.set_head({"README.md": b"base\n", **{f"file-{i}": b"x" for i in range(1 + delta)}})
    git(repo.path, "update-ref", "refs/heads/main", repo.head)
    if delta:
        with pytest.raises(CheckoutError):
            prepare_content(
                claim(repo),
                196,
                LocalTransport(repo.path),
                tmp_path / "job",
                Redactor(()),
                limits=Limits(entries=2),
            )
    else:
        result = prepare_content(
            claim(repo),
            196,
            LocalTransport(repo.path),
            tmp_path / "job",
            Redactor(()),
            limits=Limits(entries=2),
        )
        assert len(result.files) == 2


# #196-T04
@pytest.mark.parametrize("field", ["diff_bytes", "preparation_bytes", "exposed_bytes"])
def test_whole_evidence_quotas_accept_exact_and_refuse_one_over(
    repo: GitFixture, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, field: str
) -> None:
    from collections.abc import Generator

    from code_reviewer_runner.dynamic_review.limits import Budget

    captured: list[tuple[bytes | None, list[bytes]]] = []

    class RecordingTransport(LocalTransport):
        def stream(self, request: bytes | None, budget: Budget) -> Generator[bytes]:
            chunks: list[bytes] = []
            captured.append((request, chunks))
            for chunk in super().stream(request, budget):
                chunks.append(chunk)
                yield chunk

    class ReplayTransport:
        position = 0

        def stream(self, request: bytes | None, budget: Budget) -> Generator[bytes]:
            expected, chunks = captured[self.position]
            self.position += 1
            assert request == expected
            for chunk in chunks:
                budget.charge_transfer(len(chunk))
                yield chunk

    measured: list[Budget] = []
    original = Budget.charge

    def charge(budget: Budget, count: int, *, exposed: bool = False) -> None:
        if not measured:
            measured.append(budget)
        original(budget, count, exposed=exposed)

    monkeypatch.setattr(Budget, "charge", charge)
    reference = prepare_content(
        claim(repo), 196, RecordingTransport(repo.path), tmp_path / "reference", Redactor(())
    )
    budget = measured[0]
    bound = {
        "diff_bytes": len(reference.diff.encode()),
        "preparation_bytes": budget.preparation,
        "exposed_bytes": budget.exposed,
    }[field]
    limits = replace(Limits(), **{field: bound})
    prepare_content(
        claim(repo), 196, ReplayTransport(), tmp_path / "exact", Redactor(()), limits=limits
    )
    with pytest.raises(CheckoutError):
        prepare_content(
            claim(repo),
            196,
            ReplayTransport(),
            tmp_path / "over",
            Redactor(()),
            limits=replace(limits, **{field: bound - 1}),
        )


# #196-T11
def test_endpoint_diff_preserves_mode_and_final_newline_changes(
    repo: GitFixture, tmp_path: Path
) -> None:
    repo.set_head({"README.md": b"base", "executable": ("100755", b"script\n")})
    result = prepare_content(
        claim(repo), 196, LocalTransport(repo.path), tmp_path / "job", Redactor(())
    )
    assert "No newline at end of file" in result.diff
    assert "new mode 100755" in result.diff


# #196-T11
def test_a_one_line_change_in_a_large_file_emits_a_bounded_hunk(
    repo: GitFixture, tmp_path: Path
) -> None:
    original = "".join(f"line {index}\n" for index in range(5000))
    updated = original.replace("line 2500\n", "line 2500 changed\n")
    base = repo.commit({"README.md": b"base\n", "big.txt": original.encode()})
    head = repo.commit({"README.md": b"base\n", "big.txt": updated.encode()}, base)
    git(repo.path, "update-ref", "refs/heads/main", base)
    git(repo.path, "update-ref", "refs/pull/196/head", head)
    repo.head = head
    result = prepare_content(
        claim(repo), 196, LocalTransport(repo.path), tmp_path / "job", Redactor(())
    )
    assert "-line 2500\n" in result.diff and "+line 2500 changed\n" in result.diff
    assert "line 0\n" not in result.diff and "line 4999\n" not in result.diff
    assert len(result.diff.encode()) < len(original) // 10


# #196-T11
def test_base_to_head_diff_uses_the_merge_base_of_head_and_base(
    repo: GitFixture, tmp_path: Path
) -> None:
    head = repo.commit({"README.md": b"base\n", "source.py": b"print('review')\n"}, repo.base)
    git(repo.path, "update-ref", "refs/pull/196/head", head)
    moved = repo.commit({"README.md": b"base\n", "other.py": b"print('other')\n"}, repo.base)
    git(repo.path, "update-ref", "refs/heads/main", moved)
    repo.head = head
    result = prepare_content(
        claim(repo), 196, LocalTransport(repo.path), tmp_path / "job", Redactor(())
    )
    assert result.base_sha == moved and result.merge_base_sha == repo.base
    assert "source.py" in result.diff
    assert "other.py" not in result.diff
    assert "source.py" in result.files and "other.py" not in result.files


# #196-T04 #196-T11
def test_base_only_binary_and_oversized_files_never_fail_a_review(
    repo: GitFixture, tmp_path: Path
) -> None:
    head = repo.commit({"README.md": b"base\n", "source.py": b"print('review')\n"}, repo.base)
    git(repo.path, "update-ref", "refs/pull/196/head", head)
    moved = repo.commit(
        {"README.md": b"base\n", "image.bin": b"\0" * 64, "big.txt": b"a" * 2048}, repo.base
    )
    git(repo.path, "update-ref", "refs/heads/main", moved)
    repo.head = head
    result = prepare_content(
        claim(repo),
        196,
        LocalTransport(repo.path),
        tmp_path / "job",
        Redactor(()),
        limits=Limits(file_bytes=1024),
    )
    assert result.merge_base_sha == repo.base
    assert result.skipped == ()
    assert "source.py" in result.diff
    assert "image.bin" not in result.diff and "big.txt" not in result.diff


# #196-T11
def test_a_missing_merge_base_declares_a_full_review_of_the_head(
    repo: GitFixture, tmp_path: Path
) -> None:
    repo.set_head({"README.md": b"fork\n", "source.py": b"print('review')\n"}, orphan=True)
    result = prepare_content(
        claim(repo), 196, LocalTransport(repo.path), tmp_path / "job", Redactor(())
    )
    assert result.merge_base_sha is None
    assert result.comparison == "full"
    assert "source.py" in result.diff and "README.md" in result.diff
    assert set(result.files) == {"README.md", "source.py"}


# #196-T11
def test_a_binary_previous_revision_does_not_hide_a_text_change_from_the_base_diff(
    repo: GitFixture, tmp_path: Path
) -> None:
    repo.base = repo.commit({"README.md": b"base\n", "file.txt": b"base\n"})
    git(repo.path, "update-ref", "refs/heads/main", repo.base)
    previous = repo.commit({"README.md": b"base\n", "file.txt": b"\x00bin\x00"}, repo.base)
    git(repo.path, "update-ref", "refs/heads/previous", previous)
    repo.set_head({"README.md": b"base\n", "file.txt": b"changed text\n"})
    result = prepare_content(
        claim(repo, previous), 196, LocalTransport(repo.path), tmp_path / "job", Redactor(())
    )
    assert result.comparison == "incremental"
    assert "changed text" in result.diff
    assert "file.txt" in result.files
    assert "changed text" not in result.previous_diff
    assert [(skip.path, skip.reason) for skip in result.skipped] == [("file.txt", "binary")]


# #196-T11
def test_a_commit_message_cannot_forge_the_parent_of_an_orphan_head(
    repo: GitFixture, tmp_path: Path
) -> None:
    head = repo.commit(
        {"README.md": b"fork\n", "source.py": b"print('review')\n"},
        message=f"Fixture commit\n\nparent {repo.base}\n".encode(),
    )
    git(repo.path, "update-ref", "refs/pull/196/head", head)
    repo.head = head
    result = prepare_content(
        claim(repo), 196, LocalTransport(repo.path), tmp_path / "job", Redactor(())
    )
    assert result.merge_base_sha is None and result.comparison == "full"
    assert set(result.files) == {"README.md", "source.py"}


# #196-T11
def test_a_server_without_the_filter_capability_gets_a_full_head_review(tmp_path: Path) -> None:
    repo = GitFixture(tmp_path / "base.git", filtering=False)
    result = prepare_content(
        claim(repo), 196, LocalTransport(repo.path), tmp_path / "job", Redactor(())
    )
    assert result.merge_base_sha is None and result.comparison == "full"
    assert "source.py" in result.diff and "README.md" in result.diff
    assert set(result.files) == {"README.md", "source.py"}


# #196-T08 #196-T12
def test_lease_cancellation_during_hydration_keeps_other_job_data(
    repo: GitFixture, tmp_path: Path
) -> None:
    from collections.abc import Generator

    from code_reviewer_runner.dynamic_review.limits import Budget

    other = tmp_path / "other"
    other.mkdir()
    (other / "sentinel").write_text("keep")
    cancelled = False

    class CancelHydration(LocalTransport):
        requests = 0

        def stream(self, request: bytes | None, budget: Budget) -> Generator[bytes]:
            nonlocal cancelled
            if request is not None:
                self.requests += 1
                if self.requests == 3:
                    cancelled = True
            yield from super().stream(request, budget)

    with pytest.raises(CheckoutError):
        prepare_content(
            claim(repo),
            196,
            CancelHydration(repo.path),
            tmp_path / "job",
            Redactor(()),
            cancelled=lambda: cancelled,
        )
    assert not (tmp_path / "job").exists()
    assert (other / "sentinel").read_text() == "keep"


# #196-T05
def test_a_credential_shaped_filename_is_omitted_without_exposing_the_token(
    repo: GitFixture, tmp_path: Path
) -> None:
    token = "ghp_" + "A" * 30
    repo.set_head({"README.md": b"base\n", token + ".txt": b"harmless"})
    git(repo.path, "update-ref", "refs/heads/main", repo.head)
    result = prepare_content(
        claim(repo), 196, LocalTransport(repo.path), tmp_path / "job", Redactor(())
    )
    assert token + ".txt" not in result.files
    assert token not in (result.root / "evidence.json").read_text()


# #196-T01 #196-T12
def test_authorized_blob_hydration_is_batched_without_requesting_omitted_inputs(
    repo: GitFixture, tmp_path: Path
) -> None:
    from collections.abc import Generator

    from code_reviewer_runner.dynamic_review.limits import Budget

    repo.set_head(
        {"README.md": b"base\n", **{f"file-{i}.txt": f"file {i}\n".encode() for i in range(100)}}
    )
    requests: list[bytes] = []

    class TrackingTransport(LocalTransport):
        def stream(self, request: bytes | None, budget: Budget) -> Generator[bytes]:
            if request is not None and b"deepen" not in request:
                requests.append(request)
            yield from super().stream(request, budget)

    result = prepare_content(
        claim(repo), 196, TrackingTransport(repo.path), tmp_path / "job", Redactor(())
    )
    assert len(result.files) == 101
    assert len(requests) == 4
    assert all(request.count(b"want ") <= 32 for request in requests)


# #196-T07 #196-T11
def test_missing_prior_blob_declares_full_mode_without_losing_prior_findings(
    repo: GitFixture, tmp_path: Path
) -> None:
    from collections.abc import Generator

    from code_reviewer_runner.dynamic_review.limits import Budget
    from code_reviewer_runner.dynamic_review.transport import packet

    previous = repo.head
    git(repo.path, "update-ref", "refs/heads/previous", previous)
    old_blob = git(repo.path, "hash-object", "--stdin", data=b"print('review')\n").decode().strip()
    repo.set_head({"README.md": b"base\n", "source.py": b"updated\n"}, orphan=True)

    class MissingPriorBlob(LocalTransport):
        def stream(self, request: bytes | None, budget: Budget) -> Generator[bytes]:
            if request is not None and old_blob.encode() in request and b"deepen" not in request:
                yield packet(f"ERR upload-pack: not our ref {old_blob}\n".encode())
                return
            yield from super().stream(request, budget)

    result = prepare_content(
        claim(repo, previous),
        196,
        MissingPriorBlob(repo.path),
        tmp_path / "job",
        Redactor(()),
        prior_state="prior-findings",
    )
    assert result.comparison == "full" and not result.previous_diff
    assert result.prior_state == "prior-findings" and result.files["source.py"] == "updated\n"


# #202 (process-group reuse)
def test_the_git_helper_group_is_only_signalled_while_its_leader_is_not_reaped(
    repo: GitFixture, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    signals: list[tuple[int, bool]] = []
    real_killpg = os.killpg

    def killpg(pgid: int, sig: int) -> None:
        try:
            os.waitid(os.P_PID, pgid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            unreaped = True
        except ChildProcessError:
            unreaped = False
        signals.append((pgid, unreaped))
        real_killpg(pgid, sig)

    monkeypatch.setattr(os, "killpg", killpg)

    prepare_content(claim(repo), 196, LocalTransport(repo.path), tmp_path / "job", Redactor(()))

    # Every transfer ended its helper's group, and never after the leader's id could be reused.
    assert signals
    assert all(unreaped for _, unreaped in signals)


def _text_blob(seed: int, size: int) -> bytes:
    # Incompressible printable text: the wire bytes are nearly as large as the inflated ones.
    import base64
    import random

    raw = random.Random(seed).randbytes(size * 3 // 4)
    return base64.encodebytes(raw)


# #296-T05
def test_a_repository_that_the_double_charging_refused_prepares_within_the_budget(
    repo: GitFixture, tmp_path: Path
) -> None:
    files = {f"src/file-{i}.txt": _text_blob(i, 100_000) for i in range(8)}
    repo.set_head({"README.md": b"base\n", **files})
    git(repo.path, "update-ref", "refs/heads/main", repo.head)
    raw = sum(len(blob) for blob in files.values())
    # Counting the wire bytes on top of the inflated, rounded and exported ones needed about
    # 2.8 times the content; materializing it once for staging and once for export needs 2.1.
    limits = Limits(preparation_bytes=raw * 5 // 2)
    result = prepare_content(
        claim(repo),
        196,
        LocalTransport(repo.path),
        tmp_path / "job",
        Redactor(()),
        limits=limits,
    )
    assert set(files) <= set(result.files)
    assert result.metrics.preparation_bytes <= limits.preparation_bytes
    assert result.metrics.transfer_bytes > raw // 2


# #296-T12
def test_preparation_reports_peak_bytes_entries_and_omissions_without_paths(
    repo: GitFixture, tmp_path: Path
) -> None:
    repo.set_head(
        {
            "README.md": b"base\n",
            "src/code.py": b"print('x')\n",
            "assets/logo.bin": b"\0\1\2",
        }
    )
    result = prepare_content(
        claim(repo), 196, LocalTransport(repo.path), tmp_path / "job", Redactor(())
    )
    metrics = result.metrics
    assert metrics.entries == 3
    assert metrics.transfer_bytes > 0
    assert metrics.preparation_bytes >= metrics.exposed_bytes > 0
    assert metrics.omitted == {"binary": 1}
    assert metrics.skipped == {"binary": 1}
    line = metrics.describe()
    assert "entries=3" in line and "omitted=binary:1" in line and "skipped=binary:1" in line
    assert not any(name in line for name in ("logo", "code.py", "README"))


# #296-T12
def test_a_failed_preparation_still_reports_the_metrics_and_the_reason(
    repo: GitFixture, tmp_path: Path
) -> None:
    repo.set_head({"README.md": b"base\n", "big.txt": _text_blob(1, 100_000)})
    git(repo.path, "update-ref", "refs/heads/main", repo.head)
    with pytest.raises(CheckoutError) as error:
        prepare_content(
            claim(repo),
            196,
            LocalTransport(repo.path),
            tmp_path / "job",
            Redactor(()),
            limits=Limits(preparation_bytes=64 * 1024),
        )
    assert error.value.reason is CheckoutReason.BUDGET_PREPARATION
    assert error.value.metrics is not None
    assert error.value.metrics.transfer_bytes > 0
