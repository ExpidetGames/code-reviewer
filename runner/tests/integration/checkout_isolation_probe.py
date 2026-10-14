# SPDX-License-Identifier: Apache-2.0
"""Root-supervised actual-uid probe, invoked by the integration test without real network."""

import hashlib
import json
import os
import pwd
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# Isolated Python does not load the worktree or user site automatically.
sys.path.insert(0, sys.argv[1])
from code_reviewer_runner.dynamic_review.checkout import prepare_content
from code_reviewer_runner.dynamic_review.export_isolation import (
    AgentIdentity,
    prepared_checkout,
    prepared_job,
)
from code_reviewer_runner.job import parse_job

sys.path.insert(0, str(Path(sys.argv[1]).parents[1]))
from fakes.dynamic_git.server import git_server

from code_reviewer_runner.dynamic_review.limits import CheckoutError, Limits
from code_reviewer_runner.dynamic_review.transport import LocalTransport
from code_reviewer_runner.job import ClaimBase
from code_reviewer_runner.redaction import Redactor


def main() -> None:
    assert os.getuid() == 0
    repo, head, base_sha = Path(sys.argv[2]), sys.argv[3], sys.argv[4]
    user = pwd.getpwnam("nobody")
    identity = AgentIdentity(user.pw_uid, user.pw_gid)
    other_user = pwd.getpwnam("daemon")
    other = AgentIdentity(other_user.pw_uid, other_user.pw_gid)
    with tempfile.TemporaryDirectory(prefix="checkout-isolation-") as temporary:
        parent = Path(temporary)
        repo = shutil.copytree(repo, parent / "private-fixture.git")
        repo.chmod(0o700)
        # Deliberately different identities: one uid may never hold two live job exports.
        with prepared_job(parent, identity) as first, prepared_job(parent, other) as second:
            claim = ClaimBase("owner/base", "main", head, None, "full")
            content = prepare_content(
                claim, 196, LocalTransport(repo), first.directory, Redactor(())
            )
            second_content = prepare_content(
                claim, 196, LocalTransport(repo), second.directory, Redactor(())
            )
            first.seal(content)
            second.seal(second_content)
            try:
                with prepared_job(parent, identity):
                    raise AssertionError("same uid was reused")
            except CheckoutError:
                pass
            sentinel = parent / "parent-credential"
            sentinel.write_text("dummy-parent-private")
            sentinel.chmod(0o600)
            source = content.export / "README.md"
            before = hashlib.sha256(source.read_bytes()).hexdigest()
            child = r"""
import json, os, pathlib, sys
source, other, credential, parent_pid, runtime = sys.argv[1:]
assert os.getuid() != 0
assert pathlib.Path(source).read_text() == "base\n"
for path in (source, str(pathlib.Path(source).parent / "new-file")):
    try:
        pathlib.Path(path).write_text("mutated")
        raise AssertionError("export was writable")
    except PermissionError:
        pass
for path in (other, credential, f"/proc/{parent_pid}/environ", f"/proc/{parent_pid}/mem"):
    try:
        with open(path, "rb") as stream:
            stream.read(1)
        raise AssertionError("private state was readable")
    except (PermissionError, FileNotFoundError):
        pass
assert not any(
    "TOKEN" in key or "API_KEY" in key or key.startswith("OPENCODE_CONFIG")
    for key in os.environ
)
for key in (
    "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TMPDIR"
):
    directory = pathlib.Path(os.environ[key])
    assert directory.is_relative_to(runtime)
    assert list(directory.iterdir()) == []
pathlib.Path(os.environ["TMPDIR"], "bookkeeping").write_text("private")
print(json.dumps({"uid": os.getuid(), "readOnly": True, "separated": True}))
"""
            process = subprocess.run(
                [
                    "/usr/bin/python3",
                    "-I",
                    "-c",
                    child,
                    str(source),
                    str(second_content.export / "README.md"),
                    str(sentinel),
                    str(os.getpid()),
                    str(first.runtime),
                ],
                env=first.environment,
                user=identity.uid,
                group=identity.gid,
                extra_groups=(),
                capture_output=True,
                text=True,
                check=True,
                timeout=10,
            )
            assert hashlib.sha256(source.read_bytes()).hexdigest() == before
            stat = source.stat()
            assert stat.st_uid == 0 and stat.st_nlink == 1 and stat.st_mode & 0o777 == 0o440
            first_path, second_path = first.root, second.root
            assert process.stdout.strip()
        assert not first_path.exists() and not second_path.exists()
        hidden_parent = parent / "hidden-parent"
        hidden_parent.mkdir(mode=0o700)
        with prepared_job(hidden_parent / "exports", identity) as lifetime:
            result = prepare_content(
                claim, 196, LocalTransport(repo), lifetime.directory, Redactor(())
            )
            try:
                lifetime.seal(result)
                raise AssertionError("an unreadable export passed the access probe")
            except CheckoutError as error:
                assert error.code.value == "dynamic_isolation_self_check_failed"
        # The public integration seam takes a validated job and seals the exact queued head.
        fixture = Path(sys.argv[1]).parents[1] / "fakes/fixtures/dynamic-review-job.json"
        raw = json.loads(fixture.read_text())
        original_cwd = Path.cwd()
        job_cwd = parent / "cr-job-probe"
        job_cwd.mkdir(mode=0o700)
        cwd_info = job_cwd.stat()
        os.chdir(job_cwd)
        with git_server(repo) as server:
            host = server.url.removesuffix("/owner/base.git")
            raw["prUrl"] = host + "/owner/base/pull/196"
            raw["git"]["baseUrl"] = host + "/api/v3"
            raw["git"]["token"] = server.token
            raw["base"] = {
                "repository": "owner/base",
                "baseRef": "main",
                "headSha": head,
                "previousReviewedSha": None,
                "comparison": "full",
            }
            with prepared_checkout(parse_job(json.dumps(raw)), job_cwd / "wrapper", identity) as (
                result,
                lifetime,
            ):
                assert lifetime.sealed and result.head_sha == head
                assert job_cwd.stat().st_mode & 0o777 == 0o710
                assert job_cwd.stat().st_gid == identity.gid
                public_root = lifetime.root
            assert not public_root.exists()
            assert job_cwd.stat().st_mode == cwd_info.st_mode
            assert job_cwd.stat().st_gid == cwd_info.st_gid
            try:
                with prepared_checkout(
                    parse_job(json.dumps(raw)),
                    job_cwd / "bounded-wrapper",
                    identity,
                    limits=Limits(preparation_bytes=64 * 1024 - 1),
                ):
                    raise AssertionError("runtime allocation escaped the preparation budget")
            except CheckoutError as error:
                assert error.code.value == "checkout_incomplete"
        os.chdir(original_cwd)
        # Sealing refuses filesystem aliases rather than following or exposing them.
        for kind in ("symlink", "hardlink"):
            with prepared_job(parent, identity) as lifetime:
                result = prepare_content(
                    claim, 196, LocalTransport(repo), lifetime.directory, Redactor(())
                )
                target = result.export / "alias"
                if kind == "symlink":
                    target.symlink_to(sentinel)
                else:
                    os.link(sentinel, target)
                try:
                    lifetime.seal(result)
                    raise AssertionError("unsafe alias was sealed")
                except CheckoutError as error:
                    assert error.code.value == "dynamic_isolation_self_check_failed"
            assert sentinel.read_text() == "dummy-parent-private"
        config = parent / "opencode.json"
        config.write_text("{}")
        try:
            with prepared_job(parent, identity):
                raise AssertionError("ancestor config was accepted")
        except CheckoutError as error:
            assert error.code.value == "dynamic_isolation_self_check_failed"
        finally:
            config.unlink()
        for invalid in (AgentIdentity(0, 0), AgentIdentity(identity.uid, identity.gid + 1)):
            try:
                with prepared_job(parent, invalid):
                    raise AssertionError("invalid identity was accepted")
            except CheckoutError as error:
                assert error.code.value == "dynamic_isolation_self_check_failed"
        print(json.dumps({"isolation": "passed", "base": base_sha}))


if __name__ == "__main__":
    main()
