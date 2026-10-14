#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

# The two phases of the privileged suite (#244), run by run_privileged_offline.sh with the
# capabilities of compose.dynamic.yml, no-new-privileges, in the namespaces it sets up. Not meant
# to be started by hand. Both phases always run; the exit code is non-zero if either failed.
#
#   startup  the rules and the startup step, with NET_ADMIN and SETPCAP still in the bounding set
#   job      job_phase.py runs the production startup step (static rules, NET_ADMIN and SETPCAP
#            dropped for good) and then pytest in that same process
set -uo pipefail

status=0
PRIVILEGED_PHASE=startup uv run --no-sync --offline pytest -m privileged \
  -p no:cacheprovider tests/privileged/startup "$@" || status=1
PRIVILEGED_PHASE=job uv run --no-sync --offline python tests/privileged/job_phase.py "$@" \
  || status=1
exit "$status"
