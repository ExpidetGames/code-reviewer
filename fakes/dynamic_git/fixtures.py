# SPDX-License-Identifier: Apache-2.0
"""Reproducible tracked trees and base-repository fork PR refs, using real upload-pack."""

import os
import subprocess
from pathlib import Path


def git(path: Path, *args: str, data: bytes | None = None) -> bytes:
    return subprocess.run(
        ["git", "-C", str(path), *args],
        input=data,
        capture_output=True,
        check=True,
        env={
            "PATH": os.defpath,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "HOME": str(path),
            "GIT_AUTHOR_NAME": "Fixture",
            "GIT_AUTHOR_EMAIL": "fixture@example.test",
            "GIT_COMMITTER_NAME": "Fixture",
            "GIT_COMMITTER_EMAIL": "fixture@example.test",
            "GIT_AUTHOR_DATE": "2026-01-01T00:00:00Z",
            "GIT_COMMITTER_DATE": "2026-01-01T00:00:00Z",
        },
    ).stdout


class GitFixture:
    def __init__(self, path: Path, *, filtering: bool = True) -> None:
        self.path = path
        path.mkdir()
        git(path, "init", "--bare", "--initial-branch=main")
        git(path, "config", "uploadpack.allowFilter", str(filtering).lower())
        git(path, "config", "uploadpack.allowAnySHA1InWant", "true")
        self.base = self.commit({"README.md": b"base\n"})
        self.head = self.commit(
            {"README.md": b"base\n", "source.py": b"print('review')\n"}, self.base
        )
        git(path, "update-ref", "refs/heads/main", self.base)
        git(path, "update-ref", "refs/pull/196/head", self.head)

    def commit(self, files: dict[str, bytes | tuple[str, bytes]], parent: str | None = None) -> str:
        directories: dict[str, dict[str, tuple[str, str, str]]] = {"": {}}
        for name, content in files.items():
            mode, raw = content if isinstance(content, tuple) else ("100644", content)
            oid = git(self.path, "hash-object", "-w", "--stdin", data=raw).decode().strip()
            parts = name.split("/")
            for i in range(len(parts)):
                directories.setdefault("/".join(parts[:i]), {})
            directories["/".join(parts[:-1])][parts[-1]] = (mode, "blob", oid)
        tree = ""
        for directory in sorted(directories, key=lambda x: x.count("/") + bool(x), reverse=True):
            entries = b"".join(
                f"{mode} {kind} {oid}\t{name}\n".encode()
                for name, (mode, kind, oid) in sorted(directories[directory].items())
            )
            tree = git(self.path, "mktree", data=entries).decode().strip()
            if directory:
                parent_dir, _, basename = directory.rpartition("/")
                directories[parent_dir][basename] = ("040000", "tree", tree)
        args = ("-p", parent) if parent else ()
        return git(self.path, "commit-tree", tree, *args, data=b"Fixture commit\n").decode().strip()

    def set_head(self, files: dict[str, bytes | tuple[str, bytes]], *, orphan: bool = False) -> str:
        self.head = self.commit(files, None if orphan else self.base)
        git(self.path, "update-ref", "refs/pull/196/head", self.head)
        return self.head
