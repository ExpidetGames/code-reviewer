#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

# The root part of the privileged Dynamic e2e lane (#253), run by run_dynamic_e2e.sh inside
# `unshare --net --mount --pid --fork --mount-proc`. Not meant to be started by hand. It is PID 1 of the
# lane: when it ends, every process of the lane ends.
#
#   1. the network guard (app/e2e/dynamic/guard.nft) and a way out that leads nowhere, so that every
#      connection to something that is not loopback reaches the guard, which counts and rejects it;
#   2. what the Dynamic image has, in this mount namespace only: the engine user 10101 and the Diff job user
#      10001 (bind-mounted copies of passwd and group), a fresh /run, the pinned OpenCode and ripgrep at
#      /usr/local/bin, and their pin files in /opt/code-reviewer/pins (overlays, so the host is untouched);
#   3. the preflight, which names whatever is missing and stops;
#   3b. the `probe` entry mode of the Worker image (#324, #331) on this layout: with a read-only root it must advertise
#      `opencode`, with a writable one it must not (the capability probe of the hosted deployment is this verdict);
#   4. the journeys (the runner inside them is started as root with the capabilities of compose.dynamic.yml
#      and no-new-privileges: app/e2e/helpers/dynamic-runner.ts);
#   5. the last word of the guard, and a check that no process of the lane is left.
set -euo pipefail

: "${LANE_OPENCODE_BIN:?}" "${LANE_RIPGREP_BIN:?}" "${LANE_APP_DIR:?}" "${LANE_RUNNER_DIR:?}" "${LANE_STAGE:?}"
export NEXT_TELEMETRY_DISABLED=1
NODE=(node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON)

fail() {
  echo "The Dynamic e2e lane cannot start: $*" >&2
  exit 1
}

# 1. Network: loopback, the guard, and a default route into a veth pair that nothing answers on.
ip link set lo up || fail "loopback cannot be brought up"
nft -f "$LANE_APP_DIR/e2e/dynamic/guard.nft" || fail "the network guard cannot be loaded (nft, nf_tables and NET_ADMIN are needed)"
ip link add cr0 type veth peer name cr1 || fail "the veth pair of the network guard cannot be created"
ip addr add 10.255.255.1/30 dev cr0
ip link set cr0 up
ip link set cr1 up
ip route add default via 10.255.255.2 dev cr0
if ip -6 addr add fd00:255::1/126 dev cr0 nodad 2>/dev/null && ip -6 route add default via fd00:255::2 dev cr0 2>/dev/null; then
  :
else
  echo "IPv6 is not available in this namespace: no IPv6 connection can leave it either." >&2
fi

# 2. The Dynamic image's users, run directory and tools, inside this namespace only.
mount -t tmpfs tmpfs /run
STAGE="$LANE_STAGE"
mount -t tmpfs tmpfs "$STAGE"
cp /etc/passwd "$STAGE/passwd"
cp /etc/group "$STAGE/group"
for spec in 10101:cr-engine 10001:cr-job; do
  id="${spec%%:*}"
  name="${spec##*:}"
  getent group "$id" >/dev/null || echo "$name:x:$id:" >> "$STAGE/group"
  getent passwd "$id" >/dev/null || echo "$name:x:$id:$id:$name:/nonexistent:/usr/sbin/nologin" >> "$STAGE/passwd"
done
mount --bind "$STAGE/passwd" /etc/passwd
mount --bind "$STAGE/group" /etc/group

mkdir -p "$STAGE/bin-upper" "$STAGE/bin-work" "$STAGE/opt-upper" "$STAGE/opt-work"
mount -t overlay overlay -o "lowerdir=/usr/local/bin,upperdir=$STAGE/bin-upper,workdir=$STAGE/bin-work" /usr/local/bin \
  || fail "the tools cannot be installed (overlayfs on /usr/local/bin)"
mount -t overlay overlay -o "lowerdir=/opt,upperdir=$STAGE/opt-upper,workdir=$STAGE/opt-work" /opt \
  || fail "the pin files cannot be installed (overlayfs on /opt)"
# The fetch scripts leave the tools in a directory of the invoking user. Root installs from a copy on the
# lane's own tmpfs (root owned, 0700), so nothing can swap a file between the copy and the install. The
# copy is not the integrity check: the pin files (size and SHA-256) are, in the fetch scripts, in the
# preflight and in the runner's own startup self-check, which refuses any other bytes.
install -d -m 0700 -o root -g root "$STAGE/tools"
cp "$LANE_OPENCODE_BIN" "$STAGE/tools/opencode"
cp "$LANE_RIPGREP_BIN" "$STAGE/tools/rg"
install -m 0755 -o root -g root "$STAGE/tools/opencode" /usr/local/bin/opencode
install -m 0755 -o root -g root "$STAGE/tools/rg" /usr/local/bin/rg
install -d -m 0755 -o root -g root /opt/code-reviewer /opt/code-reviewer/pins
install -m 0644 -o root -g root "$LANE_RUNNER_DIR/opencode-pin.json" "$LANE_RUNNER_DIR/ripgrep-pin.json" /opt/code-reviewer/pins/

# 3. The preflight. It names what is missing and stops the lane.
"${NODE[@]}" "$LANE_APP_DIR/e2e/helpers/dynamic-preflight-command.ts"

# 3b. The `probe` entry mode on the real layout (#331). The hosted deployment advertises `opencode` from this verdict
# only, so the lane proves both directions with the pinned tools and pins installed above: the hardened container's
# read-only root passes, a writable root does not (`root_filesystem_writable`). The read-only root is made in a mount
# namespace of its own (every disk filesystem read-only, like tests/privileged in run_privileged_offline.sh), so the
# journeys below keep their writable one. The runner is started as root with exactly the capabilities of
# compose.dynamic.yml and no-new-privileges; the verdict is the one line of its stdout.
probe_as_container() {
  (
    cd "$LANE_RUNNER_DIR"
    export UV_CACHE_DIR=/run/lane-uv-cache HOME=/run/lane-home PYTHONDONTWRITEBYTECODE=1
    mkdir -p "$UV_CACHE_DIR" "$HOME"
    RUNNER_DIFF_JOB_USER=10001:10001 RUNNER_DYNAMIC_ENGINE_UID=10101 RUNNER_DYNAMIC_ENGINE_GID=10101 \
      setpriv --bounding-set=-all,+chown,+dac_override,+fowner,+kill,+setgid,+setuid,+setpcap,+net_admin \
      --inh-caps=-all --no-new-privs \
      uv run --no-sync --offline python -m code_reviewer_runner probe 2>>"$PROBE_LOG"
  )
}
make_root_read_only() {
  local failed=0 mountpoint fstype
  # The container's own writable paths (compose.dynamic.yml tmpfs): the engine's version check and the
  # startup write nowhere else once the disks are read-only.
  mount -t tmpfs -o rw,noexec,nosuid,nodev,size=512m,mode=1777 tmpfs /tmp || return 1
  while read -r mountpoint fstype; do
    case "$fstype" in
      ext2 | ext3 | ext4 | xfs | btrfs | vfat | overlay | fuseblk | squashfs | erofs | f2fs)
        mount -o remount,bind,ro "$mountpoint" || { echo "could not make $mountpoint read-only" >&2; failed=1; } ;;
    esac
  done < <(awk '{ for (i = 1; i <= NF; i++) if ($i == "-") print $5, $(i + 1) }' /proc/self/mountinfo)
  [ "$failed" = 0 ]
}
PROBE_LOG=/run/lane-probe.log
export -f probe_as_container make_root_read_only
export LANE_RUNNER_DIR PROBE_LOG
read_only_verdict="$(unshare --mount -- bash -c 'make_root_read_only && probe_as_container | tail -n 1')" \
  || fail "the probe entry mode could not be run with a read-only root"
case "$read_only_verdict" in
  *'"engines":["pr-agent","opencode"]'*'"reasons":[]'*) ;;
  *) [ ! -f "$PROBE_LOG" ] || tail -n 15 "$PROBE_LOG" >&2
     fail "the probe entry mode does not advertise opencode on the lane's layout with a read-only root (verdict: $read_only_verdict)" ;;
esac
writable_verdict="$(probe_as_container | tail -n 1)" \
  || fail "the probe entry mode could not be run with a writable root"
case "$writable_verdict" in
  *'"engines":["pr-agent"]'*root_filesystem_writable*) ;;
  *) [ ! -f "$PROBE_LOG" ] || tail -n 15 "$PROBE_LOG" >&2
     fail "the probe entry mode advertises opencode, or names another reason, on a writable root (verdict: $writable_verdict)" ;;
esac
echo "probe entry mode: opencode with a read-only root, not with a writable one"

# 4. The journeys.
cd "$LANE_APP_DIR"
status=0
./node_modules/.bin/playwright test -c playwright.dynamic.config.ts "$@" || status=$?

# 5. The guard has the last word, and nothing may be left running.
if ! "${NODE[@]}" "$LANE_APP_DIR/e2e/helpers/dynamic-lane-guard-command.ts"; then
  status=1
fi
leftovers=""
for _ in $(seq 1 100); do
  # Everything but this script and the tools that look at it is a leftover.
  leftovers="$(ps -eo pid=,user=,comm= | awk '$1 != 1 && $3 != "ps" && $3 != "awk" && $3 != "bash" && $3 != "sleep" && $3 != "seq" { print }')"
  [ -z "$leftovers" ] && break
  sleep 0.2
done
if [ -n "$leftovers" ]; then
  echo "Processes of the lane are still running after it ended:" >&2
  echo "$leftovers" >&2
  status=1
fi
exit "$status"
