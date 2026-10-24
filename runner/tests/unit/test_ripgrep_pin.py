# SPDX-License-Identifier: LicenseRef-Proprietary

"""Pins down the ripgrep pin and the helper that installs it (#202).

The engine's grep and glob run ripgrep, and the pinned OpenCode downloads one when none is on its
PATH, which the runner never allows. The image therefore carries its own, named by exact version,
release asset and digest, and installed by the same checks as the engine: a download is accepted
only with the pinned size and SHA-256, and only the one `rg` member of the archive is unpacked.
Nothing here touches the network: the download is injected.
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

SCRIPT = Path(__file__).parents[2] / "scripts" / "fetch_ripgrep.py"
PIN = Path(__file__).parents[2] / "ripgrep-pin.json"
MEMBER = "ripgrep-14.1.1-x86_64-unknown-linux-musl/rg"


def load_script() -> ModuleType:
    # The script imports its sibling `fetch_opencode`, as it does when it is run from scripts/.
    sys.path.insert(0, str(SCRIPT.parent))
    try:
        spec = importlib.util.spec_from_file_location("fetch_ripgrep", SCRIPT)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        sys.modules["fetch_ripgrep"] = module
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(str(SCRIPT.parent))
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
        "version": "14.1.1",
        "platforms": {
            "linux-x64": {
                "asset": "ripgrep.tar.gz",
                "url": "https://example.invalid/ripgrep.tar.gz",
                "member": MEMBER,
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


FAKE_RG = b"#!/bin/sh\necho 'ripgrep 14.1.1'\n"


# #202-T01
def test_the_pin_names_an_exact_unmodified_release() -> None:
    pin = json.loads(PIN.read_text(encoding="utf-8"))

    assert pin["version"] == "14.1.1"
    assert re.fullmatch(r"[0-9a-f]{40}", pin["commit"])
    assert pin["license"] == "MIT"
    entry = pin["platforms"]["linux-x64"]
    assert re.fullmatch(r"[0-9a-f]{64}", entry["archiveSha256"])
    assert re.fullmatch(r"[0-9a-f]{64}", entry["executableSha256"])
    # An exact release asset of the pinned tag over https: no latest, no package manager.
    assert entry["url"] == (
        f"https://github.com/BurntSushi/ripgrep/releases/download/{pin['tag']}/{entry['asset']}"
    )
    assert entry["member"] == f"{entry['asset'].removesuffix('.tar.gz')}/rg"
    assert "latest" not in json.dumps(pin)


# #202-T01
def test_a_verified_download_is_installed_and_reinstalling_downloads_nothing(
    tmp_path: Path,
) -> None:
    script = load_script()
    archive = archive_of(
        {MEMBER: FAKE_RG, "ripgrep-14.1.1-x86_64-unknown-linux-musl/COPYING": b"x"}
    )
    pin = pin_for(archive, FAKE_RG)

    path = script.install(tmp_path, pin=pin, key="linux-x64", download=serving(archive))

    assert path == tmp_path / "rg"
    assert path.read_bytes() == FAKE_RG
    assert path.stat().st_mode & 0o777 == 0o755
    assert [entry.name for entry in tmp_path.iterdir()] == ["rg"]

    def must_not_download(url: str, target: Path, limit: int) -> None:
        raise AssertionError("an installed, verified executable is not downloaded again")

    assert script.install(tmp_path, pin=pin, key="linux-x64", download=must_not_download) == path


# #202-T01
def test_an_archive_that_is_not_the_pinned_one_is_refused_and_leaves_nothing(
    tmp_path: Path,
) -> None:
    script = load_script()
    archive = archive_of({MEMBER: FAKE_RG})
    tampered = archive_of({MEMBER: b"#!/bin/sh\necho evil\n"})

    with pytest.raises(script.PinError):
        script.install(
            tmp_path, pin=pin_for(archive, FAKE_RG), key="linux-x64", download=serving(tampered)
        )

    assert list(tmp_path.iterdir()) == []


# #202-T01: right archive digest, but the `rg` inside is not the pinned executable.
def test_an_executable_that_is_not_the_pinned_one_is_refused(tmp_path: Path) -> None:
    script = load_script()
    archive = archive_of({MEMBER: FAKE_RG})
    pin = pin_for(archive, b"another executable")

    with pytest.raises(script.PinError):
        script.install(tmp_path, pin=pin, key="linux-x64", download=serving(archive))

    assert list(tmp_path.iterdir()) == []


# #202-T01
@pytest.mark.parametrize(
    "members",
    [
        {"other/rg": b"x"},
        {MEMBER.replace("/rg", "/rg2"): b"x"},
        {"../rg": b"x"},
        {"/tmp/rg": b"x"},
    ],
)
def test_an_archive_without_the_pinned_member_is_refused(
    tmp_path: Path, members: dict[str, bytes]
) -> None:
    script = load_script()
    archive = archive_of(members)

    with pytest.raises(script.PinError):
        script.install(
            tmp_path, pin=pin_for(archive, b"x"), key="linux-x64", download=serving(archive)
        )

    assert list(tmp_path.iterdir()) == []


# #202-T01
def test_a_link_in_place_of_the_executable_is_refused(tmp_path: Path) -> None:
    script = load_script()
    archive = archive_of({MEMBER: b""}, kind=tarfile.SYMTYPE)

    with pytest.raises(script.PinError):
        script.install(
            tmp_path, pin=pin_for(archive, b""), key="linux-x64", download=serving(archive)
        )


# #202-T01
def test_a_platform_without_a_pinned_artifact_is_refused() -> None:
    script = load_script()

    with pytest.raises(script.PinError):
        script.artifact(json.loads(PIN.read_text(encoding="utf-8")), "linux-arm64")


# #264-T10: see test_opencode_pin.py; ripgrep behaves the same, so the image builds on any platform.
def test_the_image_build_flag_turns_a_missing_pin_into_a_clear_message_and_no_ripgrep(
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
    assert "cannot install the pinned ripgrep" in capsys.readouterr().err


# #264-T10: an x86_64 host must find its pin. If the platform key were wrong there, the flagged
# image build would skip the engine with one log line instead of failing.
@pytest.mark.parametrize("machine", ["x86_64", "amd64", "AMD64"])
def test_an_x86_64_host_is_the_pinned_linux_x64_platform(
    monkeypatch: pytest.MonkeyPatch, machine: str
) -> None:
    script = load_script()
    monkeypatch.setattr(platform, "machine", lambda: machine)
    monkeypatch.setattr(sys, "platform", "linux")

    assert script.platform_key() == "linux-x64"
    assert script.artifact(json.loads(PIN.read_text(encoding="utf-8")), script.platform_key())
