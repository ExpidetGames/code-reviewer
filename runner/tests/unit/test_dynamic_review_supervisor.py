# SPDX-License-Identifier: Apache-2.0

"""The production preparation of a Dynamic job, as far as it needs no root (#197).

Sealing an export for a real second user and starting an engine as that user are proven as root by
the privileged suite (`tests/privileged`).
"""

import os
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from test_dynamic_review_run import dynamic_job

from code_reviewer_runner.dynamic_review import supervisor
from code_reviewer_runner.dynamic_review.limits import CheckoutError
from code_reviewer_runner.dynamic_review.supervisor import (
    DEFAULT_ENGINE_ID,
    ENGINE_GID_VARIABLE,
    ENGINE_UID_VARIABLE,
    Prepared,
    engine_identity,
    production_preparer,
)
from code_reviewer_runner.job import Job
from code_reviewer_runner.result import ErrorCode


# #197-T04
def test_the_engine_user_defaults_to_the_fixed_numeric_user_of_the_image() -> None:
    identity = engine_identity({})

    assert (identity.uid, identity.gid) == (DEFAULT_ENGINE_ID, DEFAULT_ENGINE_ID)


# #197-T04
def test_the_engine_user_is_taken_from_trusted_configuration() -> None:
    identity = engine_identity({ENGINE_UID_VARIABLE: "20001", ENGINE_GID_VARIABLE: "20002"})

    assert (identity.uid, identity.gid) == (20001, 20002)


# #197-T04
@pytest.mark.parametrize(
    "environment",
    [
        {ENGINE_UID_VARIABLE: "0"},
        {ENGINE_GID_VARIABLE: "0"},
        {ENGINE_UID_VARIABLE: "root"},
        {ENGINE_UID_VARIABLE: "-5"},
        {ENGINE_GID_VARIABLE: "1.5"},
        {ENGINE_UID_VARIABLE: str(os.geteuid())},
        {ENGINE_GID_VARIABLE: str(os.getegid())},
    ],
)
def test_root_the_supervisors_own_user_or_an_unusable_id_is_never_the_engine_user(
    environment: dict[str, str],
) -> None:
    with pytest.raises(CheckoutError) as caught:
        engine_identity(environment)

    assert caught.value.code is ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED


# #197-T04
def test_the_production_preparation_hands_the_adapter_the_users_directories(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    content = SimpleNamespace(export=tmp_path / "prepared" / "export")
    lifetime = SimpleNamespace(
        root=tmp_path / "job",
        environment={"HOME": str(tmp_path / "home"), "TMPDIR": str(tmp_path / "scratch")},
    )
    seen: dict[str, Any] = {}

    @contextmanager
    def fake_checkout(
        job: Job, parent: Path, identity: Any, **options: Any
    ) -> Generator[tuple[Any, Any]]:
        seen.update(parent=parent, identity=identity, options=options)
        yield content, lifetime

    monkeypatch.setattr(supervisor, "prepared_checkout", fake_checkout)
    monkeypatch.chdir(tmp_path)

    with production_preparer({ENGINE_UID_VARIABLE: "20001", ENGINE_GID_VARIABLE: "20002"})(
        dynamic_job()
    ) as prepared:
        assert isinstance(prepared, Prepared)
        assert prepared.content is content
        launch = prepared.launch
        assert launch is not None
        assert (launch.uid, launch.gid) == (20001, 20002)
        assert launch.home == str(tmp_path / "home")
        assert launch.tmpdir == str(tmp_path / "scratch")
        assert launch.config_dir == tmp_path / "job"
    # The roots of the jobs live inside the job process's own working directory.
    assert seen["parent"] == tmp_path.resolve() / supervisor.PARENT_NAME
    assert (seen["identity"].uid, seen["identity"].gid) == (20001, 20002)
