# SPDX-License-Identifier: Apache-2.0

"""The adapter's launch as the dedicated user, end to end up to the engine process (#197).

Production pieces throughout: the sealed export of `prepared_checkout` (#196) out of real Git
objects, the lease on the user, `EngineLaunch`, the nft rules and the setuid launch. Only the
engine is a stand-in (`stub_engine.py`, which reports what the process could do) and the model
proxy is a listener that accepts connections.
"""

import json
import os
import socket
import stat
import subprocess
import time
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from privileged_support import (
    API_KEY,
    ENGINE_GID,
    ENGINE_UID,
    STRANGER_GID,
    STRANGER_UID,
    TOKEN,
    Repo,
    dynamic_job,
    free_port,
    listener,
    nft_tables,
    pids_gone,
    python3,
    run_as,
    wait_for,
)

from code_reviewer_runner.dynamic_review import findings_schema
from code_reviewer_runner.dynamic_review.adapter import DynamicEngine
from code_reviewer_runner.dynamic_review.budget import BudgetLedger, DynamicLimits
from code_reviewer_runner.dynamic_review.config import new_proxy_capability
from code_reviewer_runner.dynamic_review.engine_user import EngineLaunch, user_pids
from code_reviewer_runner.dynamic_review.export_isolation import AgentIdentity, prepared_job
from code_reviewer_runner.dynamic_review.netguard import table_name
from code_reviewer_runner.dynamic_review.prompts import ReviewInputs
from code_reviewer_runner.dynamic_review.supervisor import Prepared, production_preparer


@dataclass
class Started:
    engine: DynamicEngine
    prepared: Prepared
    proxy_port: int
    capability: str

    @property
    def launch(self) -> EngineLaunch:
        assert self.prepared.launch is not None
        return self.prepared.launch

    def facts(self) -> dict[str, object]:
        path = Path(self.launch.tmpdir) / "facts.json"
        assert wait_for(path), "the engine stand-in wrote no report"
        return json.loads(path.read_text())

    def helper(self) -> dict[str, object]:
        path = Path(self.launch.tmpdir) / "helper.json"
        assert wait_for(path), "the helper wrote no report"
        return json.loads(path.read_text())


@contextmanager
def started_engine(
    repo: Repo,
    environment: dict[str, str],
    tools: Path,
    *flags: str,
    targets: dict[str, Any] | None = None,
    ports: list[int] | None = None,
) -> Generator[Started]:
    """A sealed export, the user's launch and an engine stand-in that has started."""
    job = dynamic_job(repo.head)
    with (
        listener() as proxy_port,
        production_preparer(environment, content_for=repo.content_for)(job) as prepared,
    ):
        assert isinstance(prepared, Prepared) and prepared.launch is not None
        if targets is not None:
            (Path(prepared.launch.tmpdir) / "targets.json").write_text(json.dumps(targets))
            os.chmod(Path(prepared.launch.tmpdir) / "targets.json", 0o644)
        capability = new_proxy_capability()
        engine = DynamicEngine(
            job,
            ledger=BudgetLedger(DynamicLimits()),
            command=[python3(), str(tools / "stub_engine.py"), *flags],
            directory=str(prepared.content.export),
            proxy_url=f"http://127.0.0.1:{proxy_port}",
            proxy_capability=capability,
            agent_prompt="prompt",
            model_schema=findings_schema(),
            inputs=ReviewInputs(pr_url=job.pr_url, pr_title="t", pr_body="b", diff=""),
            exported_paths=frozenset(prepared.content.files),
            require_ripgrep=False,
            startup_seconds=30.0,
            launch=prepared.launch,
            port_source=iter(ports).__next__ if ports else (lambda: free_port()),
        )
        engine.start()
        try:
            yield Started(engine, prepared, proxy_port, capability)
        finally:
            engine.stop()


# #197-T04
def test_the_engine_runs_as_the_dedicated_user_and_can_do_nothing_else(
    repo: Repo, environment: dict[str, str], tools: Path, job_dir: Path
) -> None:
    with listener() as other_job, listener("127.0.0.2") as elsewhere:
        targets = {
            "tcp": [
                ["other job", "127.0.0.1", other_job],
                ["other address", "127.0.0.2", elsewhere],
            ]
        }
        with started_engine(repo, environment, tools, targets=targets) as started:
            facts = started.facts()
            # Whose process it is: the user and its own group, no other group, no capability.
            assert (facts["uid"], facts["euid"], facts["gid"]) == (
                ENGINE_UID,
                ENGINE_UID,
                ENGINE_GID,
            )
            assert facts["groups"] in ([], [ENGINE_GID])  # no supplementary group of the supervisor
            # Not one capability in any set the process can use or inherit, and no way to gain
            # one (the compose-level `no-new-privileges` is what the suite itself runs under).
            status = facts["status"]
            assert isinstance(status, dict)
            for name in ("CapEff", "CapPrm", "CapAmb"):
                assert status[name] == "0" * 16, name
            assert status["NoNewPrivs"] == "1"
            assert facts["can_become_root"] is False
            # What it can read: its own config; not the job directory, not the supervisor.
            assert facts["can_read_config"] is True
            assert facts["can_list_job_directory"] is False
            assert facts["can_read_supervisor_environment"] is False
            # What it can change: nothing of the export.
            assert facts["can_write_export"] is False
            # What it knows: the closed environment and the config, never a job credential.
            text = json.dumps(facts["environment"])
            for secret in (API_KEY, TOKEN):
                assert secret not in text
            assert started.capability not in text
            assert started.capability in str(facts["config_text"])  # the file is its own
            # Where it can connect: another job's service and another address are refused.
            assert facts["reached"] == {"other job": False, "other address": False}
            assert table_name(ENGINE_UID) in nft_tables()
        # The engine stopped: nothing of the user runs and its rules are gone.
        assert user_pids(ENGINE_UID) == []
        assert table_name(ENGINE_UID) not in nft_tables()


# #202-config-readability #197-T04
def test_no_other_user_can_read_the_config_or_the_export_of_the_engine_user(
    repo: Repo, environment: dict[str, str], tools: Path, job_dir: Path
) -> None:
    with started_engine(repo, environment, tools) as started:
        config = Path(started.launch.config_dir) / "opencode.json"
        assert stat.S_IMODE(config.stat().st_mode) == 0o400
        assert (config.stat().st_uid, config.stat().st_gid) == (ENGINE_UID, ENGINE_GID)
        export_file = next(p for p in started.prepared.content.export.rglob("*") if p.is_file())
        read = "import sys; open(sys.argv[1], 'rb').read(1)"

        # The engine user reads both; another job's user reads neither, and cannot even list the
        # directory that holds them.
        assert run_as(ENGINE_UID, ENGINE_GID, read, str(config)).returncode == 0
        assert run_as(ENGINE_UID, ENGINE_GID, read, str(export_file)).returncode == 0
        assert run_as(STRANGER_UID, STRANGER_GID, read, str(config)).returncode != 0
        assert run_as(STRANGER_UID, STRANGER_GID, read, str(export_file)).returncode != 0
        listing = "import os, sys; os.listdir(sys.argv[1])"
        assert run_as(STRANGER_UID, STRANGER_GID, listing, str(config.parent)).returncode != 0
        # A stranger cannot write into the export either, nor can the engine user.
        write = "import sys; open(sys.argv[1] + '/x', 'w').write('x')"
        for uid, gid in ((ENGINE_UID, ENGINE_GID), (STRANGER_UID, STRANGER_GID)):
            assert run_as(uid, gid, write, str(started.prepared.content.export)).returncode != 0


# #197-T07 #197-T09
def test_a_helper_in_a_session_of_its_own_is_confined_and_killed_with_the_engine(
    repo: Repo, environment: dict[str, str], tools: Path, job_dir: Path
) -> None:
    with (
        listener() as other_job,
        listener("127.0.0.2") as elsewhere,
        socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as datagrams,
    ):
        datagrams.bind(("127.0.0.1", 0))
        datagrams.settimeout(0.5)
        targets = {
            "tcp": [
                ["other job", "127.0.0.1", other_job],
                ["other address", "127.0.0.2", elsewhere],
            ],
            "udp": [["127.0.0.1", datagrams.getsockname()[1]]],
        }
        with started_engine(
            repo, environment, tools, "--escape-helper", targets=targets
        ) as started:
            helper = started.helper()
            helper_pid = int(str(helper["pid"]))
            # It escaped the engine's process group and session; the group kill cannot reach it.
            assert os.getsid(helper_pid) != os.getsid(0)
            assert os.getpgid(helper_pid) != os.getpgid(0)
            # The helper is confined like the engine: nothing but the proxy.
            assert helper["reached"] == {"other job": False, "other address": False}
            try:
                datagrams.recvfrom(16)
                delivered = True
            except OSError:
                delivered = False
            assert delivered is False
            assert helper_pid in user_pids(ENGINE_UID)
        # The adapter ended the engine's group and then everything the user still ran.
        assert pids_gone([helper_pid])
        assert user_pids(ENGINE_UID) == []


# #197-T07
def test_the_first_start_ends_processes_a_killed_job_left_behind(
    job_dir: Path, tmp_path: Path
) -> None:
    stray = subprocess.Popen(
        [python3(), "-I", "-c", "import time; time.sleep(600)"],
        user=ENGINE_UID,
        group=ENGINE_GID,
        extra_groups=[],
        start_new_session=True,
        env={"PATH": "/usr/bin:/bin"},
    )
    try:
        assert stray.pid in user_pids(ENGINE_UID)
        launch = EngineLaunch(
            uid=ENGINE_UID,
            gid=ENGINE_GID,
            home=str(tmp_path),
            tmpdir=str(tmp_path),
            config_dir=tmp_path,
        )
        with listener() as proxy:
            launch.confine(proxy, free_port())
        launch.close()

        assert pids_gone([stray.pid])
        assert user_pids(ENGINE_UID) == []
    finally:
        stray.kill()
        stray.wait()


# #197-T07
def test_what_a_killed_job_left_is_ended_before_anything_of_the_next_job_exists(
    repo: Repo, environment: dict[str, str], job_dir: Path
) -> None:
    stray = subprocess.Popen(
        [python3(), "-I", "-c", "import time; time.sleep(600)"],
        user=ENGINE_UID,
        group=ENGINE_GID,
        extra_groups=[],
        start_new_session=True,
        env={"PATH": "/usr/bin:/bin"},
    )
    try:
        assert stray.pid in user_pids(ENGINE_UID)
        parent = job_dir / "dynamic"
        with production_preparer(environment, content_for=repo.content_for)(
            dynamic_job(repo.head)
        ) as prepared:
            assert isinstance(prepared, Prepared)
            # The survivor is gone by the time the job's directories and its export exist.
            assert stray.pid not in user_pids(ENGINE_UID)
            assert any(parent.iterdir())
    finally:
        stray.kill()
        stray.wait()


# #197-T07
def test_the_user_is_swept_after_its_lease_is_taken_and_before_the_job_directory_is_made(
    job_dir: Path,
) -> None:
    parent = job_dir / "dynamic"
    identity = AgentIdentity(ENGINE_UID, ENGINE_GID)
    seen: dict[str, object] = {}

    def on_lease() -> None:
        seen["directories"] = list(parent.iterdir())
        try:  # the lease is held: a second job on the same user is refused right now
            with prepared_job(parent, identity):
                seen["second"] = "allowed"
        except Exception as error:
            seen["second"] = type(error).__name__

    with prepared_job(parent, identity, on_lease=on_lease):
        pass

    assert seen["directories"] == []
    assert seen["second"] == "CheckoutError"


# #197-T07
def test_a_sweep_that_fails_after_the_lease_leaves_no_directory_and_frees_the_lease(
    job_dir: Path,
) -> None:
    parent = job_dir / "dynamic"
    identity = AgentIdentity(ENGINE_UID, ENGINE_GID)

    def refuse() -> None:
        raise RuntimeError("the sweep failed")

    try:
        with prepared_job(parent, identity, on_lease=refuse):
            raise AssertionError("the job must not start")
    except RuntimeError:
        pass

    assert list(parent.iterdir()) == []
    with prepared_job(parent, identity) as again:
        assert again.root.exists()


# #196-T08 #197-T07
def test_leaving_the_lifetime_removes_what_the_engine_user_filled_and_frees_its_lease(
    repo: Repo, environment: dict[str, str], tools: Path, job_dir: Path
) -> None:
    fill = (
        "import os, sys\n"
        "home = sys.argv[1]\n"
        "os.makedirs(home + '/sticky/deep/er')\n"
        "open(home + '/sticky/deep/er/file', 'w').write('x')\n"
        "os.chmod(home + '/sticky/deep/er', 0)\n"  # unreadable, unwritable directory
        "os.chmod(home + '/sticky/deep', 0o500)\n"
        "os.chmod(home + '/sticky', 0o1777)\n"  # sticky: root needs FOWNER to remove inside
    )
    with started_engine(repo, environment, tools) as started:
        root = started.launch.config_dir
        assert run_as(ENGINE_UID, ENGINE_GID, fill, started.launch.home).returncode == 0
    # The lifetime ended with the engine's stop and the context's exit.
    assert not root.exists()
    assert not any((job_dir / "dynamic").iterdir())
    # The exclusive lease on the user and its group is free again for the next job.
    with prepared_job(job_dir / "dynamic", AgentIdentity(ENGINE_UID, ENGINE_GID)) as again:
        assert again.root.exists()


# #197-T07 #202-port-ownership
def test_a_port_a_stranger_holds_is_not_the_engines_and_the_start_moves_on(
    repo: Repo, environment: dict[str, str], tools: Path, job_dir: Path
) -> None:
    taken = free_port()
    occupant = subprocess.Popen(
        [
            python3(),
            "-I",
            "-c",
            "import socket, sys, time; s = socket.socket(); "
            "s.bind(('127.0.0.1', int(sys.argv[1]))); s.listen(1); time.sleep(600)",
            str(taken),
        ],
        user=STRANGER_UID,
        group=STRANGER_GID,
        extra_groups=[],
        env={"PATH": "/usr/bin:/bin"},
    )
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            with socket.socket() as probe:
                if probe.connect_ex(("127.0.0.1", taken)) == 0:
                    break
            time.sleep(0.05)
        second = free_port()
        with started_engine(repo, environment, tools, ports=[taken, second]) as started:
            # The engine could not bind the stranger's port, exited, and was started again.
            assert started.launch.owns_listener(second)
            assert not started.launch.owns_listener(taken)
    finally:
        occupant.kill()
        occupant.wait()
