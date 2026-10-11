"""Pins down the measuring wrapper of the CR-13 spike: it runs a command (or several at once),
reports the peak memory and the duration of each, serves the canned model answer for the fake LLM
mode and reads the memory counters of the container when there are any."""

import importlib.util
import json
import sys
import urllib.request
from pathlib import Path
from types import ModuleType

SCRIPT = Path(__file__).parents[2] / "scripts" / "measure_child.py"


def load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("measure_child", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["measure_child"] = module
    spec.loader.exec_module(module)
    return module


# CR-13-T02 (tool)
def test_peak_memory_is_reported_in_megabytes_for_linux_and_macos() -> None:
    script = load_script()

    assert script.peak_rss_mb(512 * 1024, "linux") == 512.0  # kilobytes
    assert script.peak_rss_mb(512 * 1024 * 1024, "darwin") == 512.0  # bytes


# CR-13-T07 (tool)
def test_the_fake_llm_answers_with_a_chat_completion_that_holds_a_review() -> None:
    script = load_script()
    server, port = script.start_fake_llm()
    try:
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}/v1/chat/completions",
            data=json.dumps({"model": "x", "messages": []}).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            body = json.load(response)
    finally:
        server.shutdown()

    content = body["choices"][0]["message"]["content"]
    assert "review:" in content
    assert "key_issues_to_review" in content
    assert body["usage"]["total_tokens"] > 0


def test_the_memory_counters_of_a_container_are_read_when_they_exist(tmp_path: Path) -> None:
    script = load_script()
    (tmp_path / "memory.peak").write_text(str(300 * 1024 * 1024) + "\n")
    (tmp_path / "memory.events").write_text("low 0\nhigh 0\nmax 4\noom 2\noom_kill 1\n")

    cgroup = script.read_cgroup(tmp_path)

    assert cgroup == {"peakMb": 300.0, "oomKills": 1}


def test_no_container_counters_means_none(tmp_path: Path) -> None:
    assert load_script().read_cgroup(tmp_path / "missing") is None


def test_secrets_of_a_job_are_its_token_and_its_llm_key() -> None:
    script = load_script()
    job = json.dumps({"git": {"token": "tok-1234"}, "llm": {"apiKey": "key-5678"}})

    assert script.secrets_of(job) == ["tok-1234", "key-5678"]
    assert script.secrets_of("not json") == []
    assert script.secrets_of("{}") == []


def test_redaction_replaces_every_occurrence_of_a_secret() -> None:
    script = load_script()

    assert script.redact("a tok-1 b tok-1 c", ["tok-1"]) == "a [REDACTED] b [REDACTED] c"
