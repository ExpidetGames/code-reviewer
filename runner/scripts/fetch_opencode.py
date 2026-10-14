# SPDX-License-Identifier: Apache-2.0

"""Fetches the pinned, unmodified OpenCode release into a directory and verifies it (#197).

The pin is `runner/opencode-pin.json`: version, source commit, and per platform the release asset
with its archive and executable SHA-256. Nothing floats: the URL names an exact release tag, and the
download is accepted only when its size and SHA-256 equal the pin, before anything is unpacked. The
archive must hold exactly one regular file, `opencode`, which is written with a bounded copy and
checked against the executable digest. Then the binary must report the pinned version.

    uv run python scripts/fetch_opencode.py [--dest DIR]

Prints the path of the verified executable. `--allow-unpinned-platform` is for the image build only:
on a platform without a pin (anything but linux-x64) it installs nothing, says so and exits 0, so
that the image still builds there and its runner serves Diff jobs only (#264). Used by the engine
CI job (the one step with the internet, like the tiktoken cache) and by `make fetch-opencode`; the
runner image build reads the same pin in its own stage (#202). Nothing at run time downloads
anything: the engine suite and the runner only ever use an executable that this script verified.
"""

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any

PIN_FILE = Path(__file__).resolve().parents[1] / "opencode-pin.json"
EXECUTABLE = "opencode"
CHUNK = 1024 * 1024
ATTEMPTS = 3

Download = Callable[[str, Path, int], None]


class PinError(Exception):
    """The artifact is not the pinned one. The message names the check, never file content."""


class NoPinForPlatform(PinError):
    """The pin file has no entry for this platform (only linux-x64 is pinned)."""


def load_pin(path: Path = PIN_FILE) -> dict[str, Any]:
    value: Any = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise PinError("the pin file is not an object")
    return value  # pyright: ignore[reportUnknownVariableType]


def platform_key() -> str:
    machine = platform.machine().lower()
    architecture = {"x86_64": "x64", "amd64": "x64"}.get(machine, machine)
    return f"{sys.platform.removesuffix('2')}-{architecture}"


def artifact(pin: dict[str, Any], key: str) -> dict[str, Any]:
    platforms: dict[str, Any] = pin.get("platforms") or {}
    entry: Any = platforms.get(key)
    if not isinstance(entry, dict):
        raise NoPinForPlatform(f"there is no pinned OpenCode artifact for {key}")
    return entry  # pyright: ignore[reportUnknownVariableType]


def digest_of(path: Path) -> str:
    sha = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(CHUNK):
            sha.update(chunk)
    return sha.hexdigest()


class _HttpsOnlyRedirects(urllib.request.HTTPRedirectHandler):
    """The release asset is served through a redirect (GitHub's object storage); never to http."""

    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str):  # type: ignore[no-untyped-def,override]
        if not newurl.startswith("https://"):
            raise PinError("the download was redirected to something other than https")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def https_download(url: str, target: Path, limit: int) -> None:
    """Download `url` to `target`, at most `limit` bytes. Only https, also after a redirect.

    The size and digest checks come after; they are what makes the content trustworthy, the https
    rule is about not sending the request, and a credential-free one at that, over plain http.
    """
    if not url.startswith("https://"):
        raise PinError("the pinned URL is not https")
    opener = urllib.request.build_opener(_HttpsOnlyRedirects)
    with opener.open(url, timeout=120) as response, target.open("wb") as stream:
        written = 0
        while chunk := response.read(CHUNK):
            written += len(chunk)
            if written > limit:
                raise PinError("the download is larger than the pinned archive")
            stream.write(chunk)


def verify_archive(archive: Path, entry: dict[str, Any]) -> None:
    if archive.stat().st_size != entry["archiveBytes"]:
        raise PinError("the archive size is not the pinned size")
    if digest_of(archive) != entry["archiveSha256"]:
        raise PinError("the archive SHA-256 is not the pinned digest")


def unpack(archive: Path, target: Path, entry: dict[str, Any]) -> None:
    """Write the one executable of the archive to `target` with a bounded copy."""
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        if len(members) != 1 or members[0].name != EXECUTABLE or not members[0].isreg():
            raise PinError("the archive must hold exactly one regular file named opencode")
        source = bundle.extractfile(members[0])
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
        env={"PATH": "/usr/bin:/bin", "HOME": tempfile.gettempdir(), "NO_COLOR": "1"},
    )
    return done.stdout.strip()


def install(
    dest: Path,
    *,
    pin: dict[str, Any] | None = None,
    key: str | None = None,
    download: Download = https_download,
    check_version: bool = True,
) -> Path:
    """Install the pinned executable into `dest` and return its path. Idempotent."""
    pin = load_pin() if pin is None else pin
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
    work = Path(tempfile.mkdtemp(prefix="opencode-fetch-", dir=dest))
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
        if check_version and reported_version(staged) != pin["version"]:
            raise PinError("the executable does not report the pinned version")
        os.replace(staged, target)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return target


def default_destination() -> Path:
    cache = os.environ.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
    pin = load_pin()
    entry = artifact(pin, platform_key())
    return Path(cache) / "code-reviewer" / "opencode" / entry["executableSha256"][:16]


def unpinned_platform_notice(tool: str, key: str) -> str:
    return (
        f"no pin for {tool} on {key}: nothing is installed and Dynamic Review is disabled in this "
        "image (the runner serves Diff jobs only); Dynamic Review needs x86_64\n"
    )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dest", type=Path, default=None)
    parser.add_argument(
        "--allow-unpinned-platform",
        action="store_true",
        help="for the image build: on a platform without a pin install nothing and exit 0",
    )
    args = parser.parse_args(argv)
    try:
        path = install(args.dest or default_destination())
    except NoPinForPlatform:
        if not args.allow_unpinned_platform:
            sys.stderr.write(
                f"cannot install the pinned OpenCode: there is no pinned artifact for "
                f"{platform_key()}\n"
            )
            return 1
        if args.dest is not None:
            args.dest.mkdir(parents=True, exist_ok=True)
        sys.stderr.write(unpinned_platform_notice("OpenCode", platform_key()))
        return 0
    except (PinError, OSError, tarfile.TarError, subprocess.SubprocessError) as error:
        sys.stderr.write(f"cannot install the pinned OpenCode: {error}\n")
        return 1
    sys.stdout.write(f"{path}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
