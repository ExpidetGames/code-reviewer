"""Fixtures of the engine suite: the two fakes and the engine that runs jobs against them.

The engine suite needs the tiktoken encoding in its cache (PR-Agent counts tokens with it and would
otherwise download it). Its absence is a failure with the way to fix it, never a silent skip.
"""

from collections.abc import Iterator
from pathlib import Path

import pytest
from fake_github import FakeGithub
from fake_llm import FakeLlm
from harness import Engine, bpe_cache_file, default_replies


@pytest.fixture(scope="session", autouse=True)
def tiktoken_cache_is_primed() -> None:
    if not bpe_cache_file().exists():
        pytest.fail(
            f"the tiktoken cache is empty ({bpe_cache_file().parent}): run "
            "`uv run python scripts/prime_tiktoken_cache.py` once (it needs the internet)"
        )


@pytest.fixture
def github() -> Iterator[FakeGithub]:
    fake = FakeGithub()
    fake.start()
    yield fake
    fake.stop()


@pytest.fixture
def llm() -> Iterator[FakeLlm]:
    fake = FakeLlm(replies=default_replies())
    fake.start()
    yield fake
    fake.stop()


@pytest.fixture
def engine(github: FakeGithub, llm: FakeLlm, tmp_path: Path) -> Engine:
    return Engine(github, llm, tmp_path)
