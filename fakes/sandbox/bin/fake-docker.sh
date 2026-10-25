#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# A stand-in for the `docker` executable, for the host suites of the Sandbox-Launcher's local mode (#329) on a
# machine with no Docker daemon. It runs nothing: it records what it was asked, like the daemon's client would
# have been, and ends the way a Worker would.
#
#   FAKE_DOCKER_DIR          where the records go (required); never inside the "VM" directory
#   FAKE_DOCKER_IMAGE_ID     what `docker image inspect --format {{.Id}}` prints (required)
#   FAKE_DOCKER_RUN_SECONDS  how long a `docker run` lives after its stdin is closed (default 0)
#   FAKE_DOCKER_EXIT         the exit code of a `docker run` (default 0)
#
# Records: run-<n>.args (one argument per line), run-<n>.stdin, run-<n>.env (the environment of the client
# process) and run-<n>.cwd for each `docker run`; commands.log for every other command.
set -eu
dir="${FAKE_DOCKER_DIR:?FAKE_DOCKER_DIR is required}"
case "${1:-}" in
  image)
    printf '%s\n' "${FAKE_DOCKER_IMAGE_ID:?FAKE_DOCKER_IMAGE_ID is required}"
    ;;
  run)
    n="$(date +%s%N)"
    printf '%s\n' "$@" >"$dir/run-$n.args"
    env | sort >"$dir/run-$n.env"
    pwd >"$dir/run-$n.cwd"
    cat >"$dir/run-$n.stdin"
    # In short steps, so that a killed client leaves no long sleep behind.
    end=$((SECONDS + ${FAKE_DOCKER_RUN_SECONDS:-0}))
    while [ "$SECONDS" -lt "$end" ]; do sleep 0.2; done
    exit "${FAKE_DOCKER_EXIT:-0}"
    ;;
  *)
    printf '%s\n' "$*" >>"$dir/commands.log"
    ;;
esac
