"""Pins down the helper script of the manual real run: the App JWT it creates, the guard that keeps
it on the sandbox repository, and that it never prints the installation token or the LLM key, not
even when the runner's output contains them."""

import importlib.util
import subprocess
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

SCRIPT = Path(__file__).parents[2] / "scripts" / "manual_review.py"
TOKEN = "installation-token-for-the-test-0123456789"
API_KEY = "llm-key-for-the-test-0123456789"


def load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("manual_review", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["manual_review"] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def key_pair() -> tuple[str, str]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    public = (
        key.public_key()
        .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
        .decode()
    )
    return private, public


# CR-10-T12 (helper)
def test_the_app_jwt_is_signed_with_rs256_and_valid_for_less_than_ten_minutes(
    key_pair: tuple[str, str],
) -> None:
    private, public = key_pair
    script = load_script()

    encoded = script.create_app_jwt("12345", private, now=1_000_000)
    claims: dict[str, Any] = jwt.decode(
        encoded, public, algorithms=["RS256"], options={"verify_exp": False, "verify_iat": False}
    )

    assert jwt.get_unverified_header(encoded)["alg"] == "RS256"
    assert claims["iss"] == "12345"
    assert claims["exp"] - 1_000_000 <= 10 * 60
    assert claims["iat"] < 1_000_000


def test_only_pull_requests_of_the_sandbox_repository_are_accepted() -> None:
    script = load_script()

    script.check_repository("https://github.com/ExpidetGames/code-reviewer-playground/pull/1")
    for url in (
        "https://github.com/ExpidetGames/code-reviewer/pull/1",
        "https://github.com/other/code-reviewer-playground/pull/1",
        "https://evil.example.com/ExpidetGames/code-reviewer-playground/pull/1",
        "https://github.com/ExpidetGames/code-reviewer-playground/pull/1/files",
    ):
        with pytest.raises(SystemExit):
            script.check_repository(url)


def test_the_script_does_not_print_the_secrets_even_if_the_runner_output_has_them(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    script = load_script()
    for name in script.REQUIRED_ENV:
        monkeypatch.setenv(name, API_KEY if name == "OPENROUTER_API_KEY" else "1")

    def mint(*args: str | Path) -> str:
        return TOKEN

    monkeypatch.setattr(script, "mint_installation_token", mint)
    leaking = subprocess.CompletedProcess(
        args=[], returncode=0, stdout=f'{{"logTail": "{TOKEN}"}}', stderr=f"oops {API_KEY}"
    )

    def start(job: dict[str, Any]) -> subprocess.CompletedProcess[str]:
        return leaking

    monkeypatch.setattr(script, "start_runner", start)

    code = script.main([])

    printed = capsys.readouterr()
    assert code == 2
    assert TOKEN not in printed.out + printed.err
    assert API_KEY not in printed.out + printed.err
    assert "SECRET SCAN FAILED" in printed.out


def test_the_job_it_builds_carries_the_token_only_in_the_git_section() -> None:
    script = load_script()

    job = script.build_job(
        script.DEFAULT_PR_URL, "review", TOKEN, "code-reviewer", API_KEY, "vendor/model", 1000
    )

    assert job["git"]["token"] == TOKEN
    assert job["llm"]["apiKey"] == API_KEY
    assert TOKEN not in str({k: v for k, v in job.items() if k != "git"})
