# SPDX-License-Identifier: Apache-2.0
"""Real Git on disposable local repositories; no credentials or network services."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path


def git(directory: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    env = {
        "PATH": os.environ["PATH"],
        "HOME": str(directory),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_AUTHOR_NAME": "Spike",
        "GIT_AUTHOR_EMAIL": "spike@example.invalid",
        "GIT_COMMITTER_NAME": "Spike",
        "GIT_COMMITTER_EMAIL": "spike@example.invalid",
    }
    return subprocess.run(
        ["git", "-C", str(directory), *args],
        env=env,
        capture_output=True,
        text=True,
        check=check,
        timeout=20,
    )


class CheckoutProbe(unittest.TestCase):
    # #85: fetch the base repository PR ref, not a fork-provided URL.
    def test_pr_ref_and_blobless_shallow_fetch(self) -> None:
        with tempfile.TemporaryDirectory(prefix="cr85-git-") as temp:
            root = Path(temp)
            base, fork, dest = [root / n for n in ("base", "fork", "dest")]
            for repo in (base, fork, dest):
                repo.mkdir()
                git(repo, "init", "--bare" if repo != fork else "--quiet")
            (fork / "code.py").write_text("answer = 42\n")
            git(fork, "add", "code.py")
            git(fork, "commit", "-m", "fixture")
            sha = git(fork, "rev-parse", "HEAD").stdout.strip()
            blob = git(fork, "rev-parse", "HEAD:code.py").stdout.strip()
            git(base, "config", "uploadpack.allowFilter", "true")
            git(base, "config", "uploadpack.allowAnySHA1InWant", "true")
            git(fork, "push", base.as_uri(), "HEAD:refs/pull/85/head")
            git(dest, "remote", "add", "origin", base.as_uri())
            git(
                dest,
                "fetch",
                "--no-tags",
                "--depth=1",
                "--filter=blob:none",
                "origin",
                "+refs/pull/85/head:refs/spike/head",
            )
            self.assertEqual(git(dest, "rev-parse", "refs/spike/head").stdout.strip(), sha)
            self.assertEqual(
                git(dest, "rev-list", "--count", "refs/spike/head").stdout.strip(), "1"
            )
            missing = git(
                dest, "rev-list", "--objects", "--missing=print", "refs/spike/head"
            ).stdout
            self.assertIn("?" + blob, missing)
            # Trusted object read lazily hydrates the known blob from the fixed fixture origin.
            self.assertEqual(git(dest, "cat-file", "blob", blob).stdout, "answer = 42\n")

    # #85: a force push loses the old ref; missing prior head requires declared full mode.
    def test_force_push_does_not_imply_previous_commit_available(self) -> None:
        with tempfile.TemporaryDirectory(prefix="cr85-git-") as temp:
            repo = Path(temp)
            git(repo, "init", "--quiet")
            (repo / "code.py").write_text("answer = 1\n")
            git(repo, "add", "code.py")
            git(repo, "commit", "-m", "old")
            old = git(repo, "rev-parse", "HEAD").stdout.strip()
            git(repo, "update-ref", "refs/pull/85/head", old)
            git(repo, "switch", "--orphan", "replacement")
            (repo / "code.py").write_text("answer = 2\n")
            git(repo, "add", "code.py")
            git(repo, "commit", "-m", "new")
            new = git(repo, "rev-parse", "HEAD").stdout.strip()
            git(repo, "update-ref", "refs/pull/85/head", new)
            self.assertNotEqual(old, new)
            self.assertNotEqual(
                git(repo, "merge-base", "--is-ancestor", old, new, check=False).returncode, 0
            )
            # Two-dot is an endpoint tree diff; three-dot has no merge base after orphan rewrite.
            self.assertIn("answer = 2", git(repo, "diff", "--no-ext-diff", old, new).stdout)
            self.assertNotEqual(git(repo, "diff", old + "..." + new, check=False).returncode, 0)
            git(repo, "update-ref", "-d", "refs/heads/master")
            git(repo, "reflog", "expire", "--expire=now", "--all")
            git(repo, "gc", "--prune=now")
            self.assertNotEqual(git(repo, "cat-file", "-e", old, check=False).returncode, 0)


if __name__ == "__main__":
    unittest.main()
