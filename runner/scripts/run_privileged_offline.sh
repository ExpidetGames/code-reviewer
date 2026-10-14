#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

# Runs the privileged suite (pytest -m privileged, #197, #244) as the Dynamic runner would run: as
# root with exactly the capabilities of compose.dynamic.yml (cap_add) and nothing else, with
# no-new-privileges, in a Linux network namespace that has a loopback interface and no route out,
# and in a mount namespace with a fresh /run (the container mounts nothing from the host, so there
# is no Docker socket; a CI host has one). The suite starts the engine as a dedicated unprivileged
# user, installs the per-user nft rules and kills that user's processes; none of it can run as an
# ordinary user. For CI (GitHub's Ubuntu runners have passwordless sudo and the nf_tables kernel
# module); it needs `nft`, `rg`, `setpriv`, `unshare` and `ip`. On a developer machine without root,
# run the unprivileged suites instead.
#
# Two phases, as in production (ADR 0003):
#   startup  tests/privileged/startup: the capabilities the container is created with, NET_ADMIN and
#            SETPCAP included (they exist only until the engine user's static rules are installed):
#            the rules as such, and the startup step itself, run for real in a process of its own;
#   job      everything else, run by tests/privileged/job_phase.py: it runs the production startup
#            step (static rules, then NET_ADMIN and SETPCAP dropped from the bounding set for good)
#            and then pytest in the same process, so every test sees the container as a job does.
#
#   scripts/run_privileged_offline.sh [pytest arguments]
#
# The pinned OpenCode is fetched and verified first, outside the namespace (the one step that needs
# the internet, like the tiktoken cache of the engine suite).
set -euo pipefail
cd "$(dirname "$0")/.."

OPENCODE_BIN="$(uv run python scripts/fetch_opencode.py)"
for tool in rg nft setpriv unshare ip; do
  command -v "$tool" >/dev/null || [ -x "/usr/sbin/$tool" ] || { echo "$tool is not installed" >&2; exit 1; }
done

# Inside the namespace: the users the suite needs, then the production privileges and the suite.
# `env PATH=...` because sudo replaces PATH. The capability list is the cap_add of
# compose.dynamic.yml; the suite refuses to run with any other (tests/privileged/conftest.py), and a
# test (app/src/ci/compose-dynamic.test.ts) keeps this list and that file equal.
sudo --preserve-env env "PATH=$PATH:/usr/sbin:/sbin" "HOME=$HOME" "OPENCODE_BIN=$OPENCODE_BIN" \
  unshare --net --mount -- bash -c '
    set -euo pipefail
    ip link set lo up
    # A container mounts nothing from the host: nothing of the /run of the CI host (its Docker
    # socket among it) is visible to the suite, and the AF_UNIX test (#244) judges the container.
    mount -t tmpfs tmpfs /run
    # A temporary root of its own: the engine suite that ran before as the unprivileged runner user
    # left a pytest directory of that user in /tmp, which pytest refuses to share with root.
    PYTEST_DEBUG_TEMPROOT="$(mktemp -d)"
    export PYTEST_DEBUG_TEMPROOT
    for spec in 10101:cr-engine 10201:cr-stranger 10001:cr-job; do
      id="${spec%%:*}"
      name="${spec##*:}"
      getent group "$id" >/dev/null || groupadd --gid "$id" "$name"
      getent passwd "$id" >/dev/null \
        || useradd --system --uid "$id" --gid "$id" --no-create-home --shell /usr/sbin/nologin "$name"
    done
    exec setpriv \
      --bounding-set=-all,+chown,+dac_override,+fowner,+kill,+setgid,+setuid,+setpcap,+net_admin \
      --inh-caps=-all --no-new-privs \
      scripts/privileged_phases.sh "$@"
  ' privileged "$@"
