#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary

# The phases of the privileged suite (#244), run by run_privileged_offline.sh with the
# capabilities of the hardened container spec, no-new-privileges, in the namespaces it sets up. Not meant
# to be started by hand. All phases always run; the exit code is non-zero if any failed.
#
#   startup  the rules and the startup step, with NET_ADMIN and SETPCAP still in the bounding set;
#            the rules tests run for both rulesets (#345)
#   job      job_phase.py runs the production startup step (static rules, NET_ADMIN and SETPCAP
#            dropped for good) and then pytest in that same process
#   job, fallback  the same with the startup step told that the kernel has no nf_tables `inet` or
#            `reject` (#345): the `ip`-family rules and IPv6 off, and the files that depend on the
#            ruleset (`FALLBACK_TESTS` in job_phase.py). The full ruleset is what the plain job
#            pass runs; there the strict assertion of an immediate refusal stays.
set -uo pipefail

# The passes share one network namespace, and the rules of a job pass outlive its process (nobody
# can remove them any more, which is the point). This script still holds NET_ADMIN, so it clears
# the engine user's tables (both families) between passes, and puts IPv6 back after the fallback
# pass switched it off: each pass, and the execve phase after them, starts from a clean namespace.
nft_binary="$(command -v nft || echo /usr/sbin/nft)"
ipv6_before="$(for setting in /proc/sys/net/ipv6/conf/*/disable_ipv6; do
  [ -r "$setting" ] && echo "$setting $(cat "$setting")"
done)"
clear_engine_rules() {
  for family in inet ip; do
    "$nft_binary" delete table "$family" code_reviewer_engine_10101 2>/dev/null || true
  done
}
restore_ipv6() {
  while read -r setting value; do
    [ -n "$setting" ] && echo "$value" > "$setting"
  done <<< "$ipv6_before"
}

status=0
PRIVILEGED_PHASE=startup uv run --no-sync --offline pytest -m privileged \
  -p no:cacheprovider tests/privileged/startup "$@" || status=1
PRIVILEGED_PHASE=job uv run --no-sync --offline python tests/privileged/job_phase.py "$@" \
  || status=1
clear_engine_rules
PRIVILEGED_PHASE=job CR_PRIVILEGED_EGRESS_MODE=fallback \
  uv run --no-sync --offline python tests/privileged/job_phase.py "$@" || status=1
clear_engine_rules
restore_ipv6
exit "$status"
