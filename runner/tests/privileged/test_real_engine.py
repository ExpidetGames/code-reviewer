# SPDX-License-Identifier: Apache-2.0

"""The real pinned stock OpenCode as the dedicated user, behind the network rules (#197-T04/T09).

The whole production path as root with the production capabilities: the sealed export of the real
#196 preparation out of real Git objects, the engine user's lease and directories, the nft rules,
the setuid launch of the unmodified v1.19.0 executable, the runner-owned model proxy and a scripted
loopback model. Asserts what ran as whom and what is left, never review quality.
"""

import json
import shutil
import sys
import tempfile
import time
from collections.abc import Generator
from pathlib import Path

import pytest
from privileged_support import (
    CAPABILITIES,
    ENGINE_GID,
    ENGINE_UID,
    Repo,
    connect_as,
    dynamic_job,
    listener,
)

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine"))
from opencode_support import (
    ScriptedModel,
    asks,
    extra_path,
    findings_for,
    opencode_binary,
    tool_call,
)

from code_reviewer_runner import runner
from code_reviewer_runner.capabilities import ALL_ENGINES
from code_reviewer_runner.dynamic_review.engine_user import user_pids
from code_reviewer_runner.dynamic_review.supervisor import (
    ENGINE_GID_VARIABLE,
    ENGINE_UID_VARIABLE,
    production_preparer,
)


@pytest.fixture(scope="module")
def engine_binary() -> Generator[Path]:
    """The verified executable in a directory every user can enter (the cache is the CI user's)."""
    directory = Path(tempfile.mkdtemp(prefix="cr-privileged-engine-"))
    directory.chmod(0o755)
    target = directory / "opencode"
    shutil.copyfile(opencode_binary(), target)
    target.chmod(0o755)
    yield target
    shutil.rmtree(directory, ignore_errors=True)


def plugin(sentinel: Path) -> bytes:
    return (
        'import { writeFileSync } from "node:fs"\n'
        f'writeFileSync("{sentinel}", "executed")\n'
        "export default async () => ({})\n"
    ).encode()


# #197-T04 #197-T09
def test_the_real_engine_reviews_as_the_dedicated_user_and_leaves_nothing_behind(
    tmp_path: Path, job_dir: Path, engine_binary: Path, request: pytest.FixtureRequest
) -> None:
    # Even where the engine user can write, a plugin must not run: a directory it can reach.
    sentinels = Path(tempfile.mkdtemp(prefix="cr-sentinels-"))
    sentinels.chmod(0o777)
    request.addfinalizer(lambda: shutil.rmtree(sentinels, ignore_errors=True))
    repo = Repo(
        tmp_path / "base.git",
        {
            "README.md": b"# demo\n",
            "AGENTS.md": b"RULE_MARKER\n",
            "src/app.py": b"def handler(user):\n    return query(user)\n",
            "evil-root.js": plugin(sentinels / "root-plugin"),
            "opencode.json": json.dumps({"plugin": ["./evil-root.js"]}).encode(),
            ".opencode/plugins/evil.js": plugin(sentinels / "dot-opencode"),
        },
        {"src/app.py": b"def handler(user):\n    return query(user)  # changed\n"},
    )
    seen: dict[str, object] = {}

    def on_request(count: int) -> None:
        if count != 1:
            return
        # The first model call, made by the engine through the proxy: whose process is it?
        pids = user_pids(ENGINE_UID)
        seen["pids"] = pids

    model = ScriptedModel(
        steps=[
            lambda body: asks(
                tool_call("read_1", "read", {"filePath": str(_export(job_dir) / "src/app.py")})
            )
        ],
        final=findings_for(repo.head),
        on_request=on_request,
    )
    environment = {
        runner.OPENCODE_COMMAND_VARIABLE: str(engine_binary),
        runner.DYNAMIC_CAPABILITIES_VARIABLE: CAPABILITIES,
        ENGINE_UID_VARIABLE: str(ENGINE_UID),
        ENGINE_GID_VARIABLE: str(ENGINE_GID),
    }
    extra = extra_path()
    if extra:
        environment[runner.DYNAMIC_NODE_BIN_VARIABLE] = extra

    with model:
        result = runner.run_dynamic_job(
            dynamic_job(repo.head, base_url=f"{model.url}/v1"),
            None,
            time.monotonic(),
            environment,
            170.0,
            engines=ALL_ENGINES,
            prepare=production_preparer(
                environment, content_for=repo.content_for, context_for=repo.context_for
            ),
        )

    assert result.ok, (result.error_code, result.log_tail)
    # The engine (and only the dedicated user) was running while the model was being called, and
    # the call reached the proxy on the slot's fixed port, which the static rules allow.
    assert seen["pids"], "the engine user ran the engine"
    # The hostile repository did not run, even though the engine user could have written there.
    assert list(sentinels.iterdir()) == []
    # The file it read reached the model through the proxy.
    assert "def handler(user)" in "\n".join(model.tool_results().values())
    # Nothing is left: no process of the user and no job files; the static rules stay.
    assert user_pids(ENGINE_UID) == []
    with listener() as elsewhere:
        reached = connect_as(ENGINE_UID, ENGINE_GID, [("elsewhere", "127.0.0.1", elsewhere)])
    assert reached["elsewhere"]["connected"] is False
    assert not list((job_dir / "dynamic").glob("job-*"))


def _export(job_dir: Path) -> Path:
    """Where the production preparation puts the export of the one job in this working directory."""
    return next((job_dir / "dynamic").glob("job-*/prepared/checkout"))
