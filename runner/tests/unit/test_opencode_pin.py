# SPDX-License-Identifier: Apache-2.0

"""Pins down the OpenCode pin and the helper that installs it (#197).

The engine is the unmodified upstream release, named by exact version, source commit and archive
digest. The helper accepts a download only when its size and SHA-256 equal the pin, and unpacks
exactly one regular file. Nothing here touches the network: the download is injected.
"""

import hashlib
import importlib.util
import io
import json
import platform
import re
import sys
import tarfile
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from code_reviewer_runner.dynamic_review.adapter import PINNED_ENGINE_VERSION

SCRIPT = Path(__file__).parents[2] / "scripts" / "fetch_opencode.py"
PIN = Path(__file__).parents[2] / "opencode-pin.json"


def load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("fetch_opencode", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["fetch_opencode"] = module
    spec.loader.exec_module(module)
    return module


def archive_of(members: dict[str, bytes], *, kind: bytes = tarfile.REGTYPE) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as bundle:
        for name, content in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(content)
            info.type = kind
            bundle.addfile(info, io.BytesIO(content))
    return buffer.getvalue()


def pin_for(archive: bytes, executable: bytes) -> dict[str, Any]:
    return {
        "version": "1.19.0",
        "platforms": {
            "linux-x64": {
                "asset": "opencode-linux-x64.tar.gz",
                "url": "https://example.invalid/opencode-linux-x64.tar.gz",
                "archiveBytes": len(archive),
                "archiveSha256": hashlib.sha256(archive).hexdigest(),
                "executableBytes": len(executable),
                "executableSha256": hashlib.sha256(executable).hexdigest(),
            }
        },
    }


def serving(archive: bytes) -> Any:
    def download(url: str, target: Path, limit: int) -> None:
        assert url.startswith("https://")
        target.write_bytes(archive)

    return download


# #197-T02
def test_the_pin_names_an_exact_unmodified_release() -> None:
    pin = json.loads(PIN.read_text(encoding="utf-8"))

    assert pin["version"] == PINNED_ENGINE_VERSION == "1.19.0"
    assert pin["tag"] == f"v{pin['version']}"
    assert re.fullmatch(r"[0-9a-f]{40}", pin["commit"])
    assert pin["license"] == "MIT"
    entry = pin["platforms"]["linux-x64"]
    assert re.fullmatch(r"[0-9a-f]{64}", entry["archiveSha256"])
    assert re.fullmatch(r"[0-9a-f]{64}", entry["executableSha256"])
    # An exact release asset of the pinned tag over https: no latest, no installer, no registry.
    assert entry["url"] == (
        f"https://github.com/anomalyco/opencode/releases/download/{pin['tag']}/{entry['asset']}"
    )
    assert "latest" not in json.dumps(pin)


# #197-T02
def test_a_verified_download_is_installed_and_reinstalling_downloads_nothing(
    tmp_path: Path,
) -> None:
    script = load_script()
    executable = b"#!/bin/sh\necho 1.19.0\n"
    archive = archive_of({"opencode": executable})
    pin = pin_for(archive, executable)

    path = script.install(tmp_path, pin=pin, key="linux-x64", download=serving(archive))

    assert path == tmp_path / "opencode"
    assert path.read_bytes() == executable
    assert path.stat().st_mode & 0o777 == 0o755
    assert [entry.name for entry in tmp_path.iterdir()] == ["opencode"]

    def must_not_download(url: str, target: Path, limit: int) -> None:
        raise AssertionError("an installed, verified executable is not downloaded again")

    assert script.install(tmp_path, pin=pin, key="linux-x64", download=must_not_download) == path


# #197-T02
def test_an_archive_that_is_not_the_pinned_one_is_refused_and_leaves_nothing(
    tmp_path: Path,
) -> None:
    script = load_script()
    executable = b"#!/bin/sh\necho 1.19.0\n"
    archive = archive_of({"opencode": executable})
    pin = pin_for(archive, executable)
    tampered = archive_of({"opencode": b"#!/bin/sh\necho evil\n"})

    with pytest.raises(script.PinError):
        script.install(tmp_path, pin=pin, key="linux-x64", download=serving(tampered))

    assert list(tmp_path.iterdir()) == []


# #197-T02
@pytest.mark.parametrize(
    "members",
    [
        {"opencode": b"x", "extra": b"y"},
        {"other": b"x"},
        {"../opencode": b"x"},
        {"dir/opencode": b"x"},
    ],
)
def test_an_archive_with_anything_but_the_one_executable_is_refused(
    tmp_path: Path, members: dict[str, bytes]
) -> None:
    script = load_script()
    archive = archive_of(members)
    pin = pin_for(archive, b"x")

    with pytest.raises(script.PinError):
        script.install(tmp_path, pin=pin, key="linux-x64", download=serving(archive))

    assert list(tmp_path.iterdir()) == []


# #197-T02
def test_a_link_in_place_of_the_executable_is_refused(tmp_path: Path) -> None:
    script = load_script()
    archive = archive_of({"opencode": b""}, kind=tarfile.SYMTYPE)
    pin = pin_for(archive, b"")

    with pytest.raises(script.PinError):
        script.install(tmp_path, pin=pin, key="linux-x64", download=serving(archive))


# #197-T02
def test_an_executable_that_reports_another_version_is_refused(tmp_path: Path) -> None:
    script = load_script()
    executable = b"#!/bin/sh\necho 1.20.0\n"
    archive = archive_of({"opencode": executable})

    with pytest.raises(script.PinError):
        script.install(
            tmp_path, pin=pin_for(archive, executable), key="linux-x64", download=serving(archive)
        )

    assert list(tmp_path.iterdir()) == []


# #197-T02
def test_a_platform_without_a_pinned_artifact_is_refused() -> None:
    script = load_script()

    with pytest.raises(script.PinError):
        script.artifact(json.loads(PIN.read_text(encoding="utf-8")), "linux-arm64")


# #197-T02
def test_a_download_url_that_is_not_https_is_refused() -> None:
    script = load_script()

    with pytest.raises(script.PinError):
        script.https_download("http://example.invalid/x", Path("/nonexistent"), 10)


# #197-nit
@pytest.mark.parametrize(
    "target", ["http://example.invalid/asset", "ftp://example.invalid/asset", "file:///etc/passwd"]
)
def test_a_redirect_to_anything_but_https_is_refused(target: str) -> None:
    import urllib.request

    script = load_script()
    handler = script._HttpsOnlyRedirects()  # pyright: ignore[reportPrivateUsage]
    request = urllib.request.Request("https://example.invalid/asset")

    with pytest.raises(script.PinError, match="redirect"):
        handler.redirect_request(request, io.BytesIO(), 302, "Found", {}, target)  # pyright: ignore[reportArgumentType]


# #197-nit
def test_a_redirect_to_another_https_url_is_followed() -> None:
    import urllib.request

    script = load_script()
    handler = script._HttpsOnlyRedirects()  # pyright: ignore[reportPrivateUsage]
    request = urllib.request.Request("https://example.invalid/asset")

    followed = handler.redirect_request(
        request,
        io.BytesIO(),  # pyright: ignore[reportArgumentType]
        302,
        "Found",
        {},  # pyright: ignore[reportArgumentType]
        "https://objects.example.invalid/asset",
    )

    assert followed is not None and followed.full_url == "https://objects.example.invalid/asset"


# #264-T10: the image build must never fail on a platform without a pin (an arm64 Coolify server
# builds this stage too). With the flag the Dockerfile passes, the script installs nothing, says so
# and exits 0; the strict default (CI, `make fetch-opencode`) still refuses.
def test_the_image_build_flag_turns_a_missing_pin_into_a_clear_message_and_no_engine(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    script = load_script()
    monkeypatch.setattr(platform, "machine", lambda: "aarch64")

    assert script.main(["--dest", str(tmp_path / "tools"), "--allow-unpinned-platform"]) == 0

    captured = capsys.readouterr()
    assert captured.out == ""
    assert "linux-aarch64" in captured.err
    assert "no pin" in captured.err
    assert "Dynamic Review is disabled" in captured.err
    assert list((tmp_path / "tools").iterdir()) == []


# #264-T10
def test_without_the_flag_a_missing_pin_still_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    script = load_script()
    monkeypatch.setattr(platform, "machine", lambda: "aarch64")

    assert script.main(["--dest", str(tmp_path / "tools")]) == 1
    assert "cannot install the pinned OpenCode" in capsys.readouterr().err


# #264-T10: the flag is only for a missing pin; a download that is not the pinned one still fails.
def test_the_flag_does_not_excuse_an_artifact_that_is_not_the_pinned_one(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    script = load_script()

    def tampered(*args: Any, **options: Any) -> Path:
        raise script.PinError("the archive SHA-256 is not the pinned digest")

    monkeypatch.setattr(script, "install", tampered)

    assert script.main(["--dest", str(tmp_path), "--allow-unpinned-platform"]) == 1
