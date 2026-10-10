"""Helpers shared by the process level tests of the job loop (not a test file)."""

import json
import os
import time
from pathlib import Path
from typing import Any

FAKE_JOB = Path(__file__).parent / "fake_job.py"
TOKEN = "dummy-installation-token-0123456789"
API_KEY = "dummy-openrouter-key-0123456789"


def job_id(number: int) -> str:
    return f"00000000-0000-4000-8000-{number:012d}"


def job_input(**overrides: Any) -> dict[str, Any]:
    value: dict[str, Any] = {
        "prUrl": "https://github.com/octo/repo/pull/7",
        "command": "review",
        "git": {
            "provider": "github",
            "baseUrl": "https://api.github.com",
            "token": TOKEN,
            "botLogin": "code-reviewer[bot]",
        },
        "llm": {"provider": "openrouter", "model": "vendor/model", "apiKey": API_KEY},
        "env": {},
    }
    value.update(overrides)
    return value


def reports(directory: Path) -> list[dict[str, Any]]:
    return [json.loads(path.read_text()) for path in sorted(directory.glob("[0-9]*.json"))]


def gone(pid: int, seconds: float = 5.0) -> bool:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        time.sleep(0.05)
    return False
