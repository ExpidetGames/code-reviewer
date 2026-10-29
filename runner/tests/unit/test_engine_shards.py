# SPDX-License-Identifier: LicenseRef-Proprietary

"""The two engine shards of CI (#713) split the engine suite without losing or doubling a file."""

from pathlib import Path

from engine_shards import OPENCODE_FILES, SHARDS, shard_of, split_by_shard

ENGINE_TESTS = Path(__file__).resolve().parents[1] / "engine"


def engine_test_files() -> list[Path]:
    return sorted(ENGINE_TESTS.glob("test_*.py"))


# #713-T01
def test_every_engine_test_file_is_in_exactly_one_shard() -> None:
    files = engine_test_files()

    assert files
    by_shard = {shard: [f for f in files if shard_of(f) == shard] for shard in SHARDS}
    assert sorted(f for group in by_shard.values() for f in group) == files
    assert all(by_shard.values()), "a shard without a test file is a job that proves nothing"


# #713-T01
def test_the_opencode_list_names_files_that_exist() -> None:
    present = {f.name for f in engine_test_files()}

    assert sorted(OPENCODE_FILES - present) == []


# #713-T01
def test_a_file_nobody_listed_runs_in_the_pr_agent_shard() -> None:
    assert shard_of(ENGINE_TESTS / "test_engine_a_new_file.py") == "pragent"


class Item:
    def __init__(self, path: Path) -> None:
        self.path = path


# #713-T01
def test_the_shard_option_keeps_its_engine_files_and_every_test_outside_the_engine_suite() -> None:
    tests = Path(__file__).resolve().parents[1]
    items = [
        Item(ENGINE_TESTS / "test_engine_cost.py"),
        Item(ENGINE_TESTS / "test_engine_opencode.py"),
        Item(tests / "unit" / "test_engine_shards.py"),
    ]

    kept, dropped = split_by_shard(items, "opencode", tests)
    assert [i.path.name for i in kept] == ["test_engine_opencode.py", "test_engine_shards.py"]
    assert [i.path.name for i in dropped] == ["test_engine_cost.py"]

    kept, dropped = split_by_shard(items, "pragent", tests)
    assert [i.path.name for i in kept] == ["test_engine_cost.py", "test_engine_shards.py"]
    assert [i.path.name for i in dropped] == ["test_engine_opencode.py"]

    kept, dropped = split_by_shard(items, None, tests)
    assert kept == items and dropped == []
