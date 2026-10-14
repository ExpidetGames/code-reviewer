# SPDX-License-Identifier: Apache-2.0

"""Fetches the pinned ripgrep release into a directory and verifies it (#202).

The engine's grep and glob run ripgrep; the pinned OpenCode would download one when none is on its
PATH, which the runner never allows. The Dynamic runner image carries this one instead. The pin is
`runner/ripgrep-pin.json`, in the shape of `opencode-pin.json`: version, source commit, and per
platform the release asset with its archive and executable SHA-256 and the one archive member that
is the executable. It is checked exactly like the engine (`fetch_opencode.py`): the download is
accepted only when its size and SHA-256 equal the pin, before anything is unpacked; only the one
pinned member is written, with a bounded copy, and checked against the executable digest; then
`rg --version` must report the pinned version.

    python scripts/fetch_ripgrep.py [--dest DIR]

Prints the path of the verified executable. The image build runs it in its own stage (the one step
with the internet); nothing at run time downloads anything. The runner's startup self-check hashes
the installed file against the same pin again (`dynamic_review/self_check.py`).
"""

import argparse
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path
from typing import Any

from fetch_opencode import (
    ATTEMPTS,
    CHUNK,
    Download,
    PinError,
    artifact,
    digest_of,
    https_download,
    load_pin,
    platform_key,
    verify_archive,
)

PIN_FILE = Path(__file__).resolve().parents[1] / "ripgrep-pin.json"
EXECUTABLE = "rg"


def unpack(archive: Path, target: Path, entry: dict[str, Any]) -> None:
    """Write the one pinned member of the archive to `target` with a bounded copy."""
    with tarfile.open(archive, "r:gz") as bundle:
        member = next((item for item in bundle.getmembers() if item.name == entry["member"]), None)
        if member is None or not member.isreg():
            raise PinError("the archive does not hold the pinned ripgrep executable")
        source = bundle.extractfile(member)
        if source is None:
            raise PinError("the archive member cannot be read")
        limit = entry["executableBytes"]
        written = 0
        with source, target.open("wb") as stream:
            while chunk := source.read(CHUNK):
                written += len(chunk)
                if written > limit:
                    raise PinError("the executable is larger than the pinned size")
                stream.write(chunk)
    if target.stat().st_size != limit or digest_of(target) != entry["executableSha256"]:
        raise PinError("the executable is not the pinned executable")
    target.chmod(0o755)


def reported_version(executable: Path) -> str:
    done = subprocess.run(
        [str(executable), "--version"],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
        env={"PATH": "/usr/bin:/bin", "HOME": tempfile.gettempdir()},
    )
    return done.stdout.splitlines()[0].strip() if done.stdout.strip() else ""


def install(
    dest: Path,
    *,
    pin: dict[str, Any] | None = None,
    key: str | None = None,
    download: Download = https_download,
    check_version: bool = True,
) -> Path:
    """Install the pinned executable into `dest` and return its path. Idempotent."""
    pin = load_pin(PIN_FILE) if pin is None else pin
    entry = artifact(pin, key or platform_key())
    target = dest / EXECUTABLE
    if (
        target.is_file()
        and target.stat().st_size == entry["executableBytes"]
        and digest_of(target) == entry["executableSha256"]
    ):
        return target
    dest.mkdir(parents=True, exist_ok=True)
    # A private directory for the download: nothing half verified ever sits at the final path.
    work = Path(tempfile.mkdtemp(prefix="ripgrep-fetch-", dir=dest))
    try:
        archive = work / entry["asset"]
        for attempt in range(1, ATTEMPTS + 1):
            try:
                download(entry["url"], archive, entry["archiveBytes"])
                break
            except OSError:
                if attempt == ATTEMPTS:
                    raise
        verify_archive(archive, entry)
        staged = work / EXECUTABLE
        unpack(archive, staged, entry)
        # `ripgrep 14.1.1 (rev 4649aa9700)`: the first line starts with name and version.
        if check_version and not reported_version(staged).startswith(f"ripgrep {pin['version']}"):
            raise PinError("the executable does not report the pinned version")
        os.replace(staged, target)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return target


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dest", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        path = install(args.dest)
    except (PinError, OSError, tarfile.TarError, subprocess.SubprocessError) as error:
        sys.stderr.write(f"cannot install the pinned ripgrep: {error}\n")
        return 1
    sys.stdout.write(f"{path}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
