# SPDX-License-Identifier: Apache-2.0

"""The engines file: the verdict of the startup self-check, kept for whatever starts Workers (#324).

Every entry mode runs the same startup once, at container start (`job_loop.service.run_startup`):
the engine user's network rules, the end of `NET_ADMIN`, the self-check. Its verdict is written to
`/run/code-reviewer-engines.json`, so that a launcher inside the same container (#334) reads what
was established instead of repeating the check, which would need the capabilities that are gone.

The file is readable by root only and lives on the `/run` tmpfs: it is empty again after every
restart, and a verdict is never written to a disk filesystem where it could outlive the start that
produced it. A start that cannot write it (not root, `/run` not a tmpfs) writes none and says why;
the file is an aid, not a gate. The old file is removed before the new startup runs, so a start
that fails halfway leaves no verdict of an earlier one.
"""

import contextlib
import logging
import os
import re
from collections.abc import Callable
from pathlib import Path

from code_reviewer_runner.verdict import Verdict

ENGINES_FILE = Path("/run/code-reviewer-engines.json")
MOUNT_TABLE = Path("/proc/self/mountinfo")
LOGGER_NAME = "code_reviewer_runner.loop"

NOT_ROOT = "not_root"
NOT_ON_TMPFS = "not_on_tmpfs"
WRITE_FAILED = "write_failed"

_OCTAL_ESCAPE = re.compile(r"\\([0-7]{3})")


def _read_mount_table() -> str:
    try:
        return MOUNT_TABLE.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _unescape(mount_point: str) -> str:
    """The kernel writes a space, tab, newline or backslash in a path as a three-digit octal."""
    return _OCTAL_ESCAPE.sub(lambda found: chr(int(found.group(1), 8)), mount_point)


def filesystem_type(path: Path, mountinfo: str) -> str | None:
    """The filesystem type of the deepest mount at or above `path`; None if the table says none.

    Of several mounts on one point the last listed (the top one) counts.
    """
    best: tuple[int, str] | None = None
    for line in mountinfo.splitlines():
        before, separator, after = line.partition(" - ")
        fields, rest = before.split(), after.split()
        if not separator or len(fields) < 5 or not rest:
            continue
        mount_point = Path(_unescape(fields[4]))
        if mount_point != path and mount_point not in path.parents:
            continue
        depth = len(mount_point.parts)
        if best is None or depth >= best[0]:
            best = (depth, rest[0])
    return best[1] if best else None


def remove_engines_file(path: Path = ENGINES_FILE) -> None:
    """Remove the file of an earlier start; nothing there is fine."""
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except OSError:
        logging.getLogger(LOGGER_NAME).warning("the engines file of an earlier start stays")


def write_engines_file(
    verdict: Verdict,
    path: Path = ENGINES_FILE,
    *,
    euid: Callable[[], int] = os.geteuid,
    mountinfo: Callable[[], str] = _read_mount_table,
) -> str | None:
    """Write the verdict; returns None, or the stable reason why no file was written.

    The file is created with mode 0600 next to its final name and renamed over it: a link planted
    at the final name is replaced, never followed, and a reader never sees half a document.
    """
    log = logging.getLogger(LOGGER_NAME)
    if euid() != 0:
        # The default runner is not root and has nothing to hide: not worth a line.
        log.debug("the engines file is not written (%s)", NOT_ROOT)
        return NOT_ROOT
    if filesystem_type(path.parent.resolve(), mountinfo()) != "tmpfs":
        log.warning("the engines file is not written (%s)", NOT_ON_TMPFS)
        return NOT_ON_TMPFS
    temporary = path.with_name(f".{path.name}.{os.getpid()}")
    try:
        descriptor = os.open(
            temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600
        )
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(verdict.to_json() + "\n")
        os.replace(temporary, path)
    except OSError:
        with contextlib.suppress(OSError):
            temporary.unlink()
        log.warning("the engines file is not written (%s)", WRITE_FAILED)
        return WRITE_FAILED
    return None
