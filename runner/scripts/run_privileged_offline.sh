#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary

# Runs the privileged suite (pytest -m privileged, #197, #244) as the Dynamic runner would run: as
# root with exactly the capabilities of compose.dynamic.yml (cap_add) and nothing else, with
# no-new-privileges, in a Linux network namespace that has a loopback interface and no route out,
# and in a mount namespace laid out like the container (#249): every disk filesystem read-only, a
# fresh tmpfs on /run and /tmp with the options of compose.dynamic.yml, a throwaway HOME. Nothing is
# mounted from the host, so there is no Docker socket (a CI host has one), and the suite runs on the
# only writable paths the container has. The suite starts the engine as a dedicated unprivileged
# user, installs the per-user nft rules and kills that user's processes; none of it can run as an
# ordinary user. For CI (GitHub's Ubuntu runners have passwordless sudo and the nf_tables kernel
# module); it needs `nft`, `rg`, `setpriv`, `unshare` and `ip`. On a developer machine without root,
# run the unprivileged suites instead.
#
# Three phases, as in production (ADR 0003):
#   startup  tests/privileged/startup: the capabilities the container is created with, NET_ADMIN and
#            SETPCAP included (they exist only until the engine user's static rules are installed):
#            the rules as such, and the startup step itself, run for real in a process of its own;
#   job      everything else, run by tests/privileged/job_phase.py: it runs the production startup
#            step (static rules, then NET_ADMIN and SETPCAP dropped from the bounding set for good)
#            and then pytest in the same process, so every test sees the container as a job does;
#   execve   tests/privileged/execve (#249): the same, started WITHOUT no-new-privileges, so that the
#            bounding set alone is what keeps a file-capability or setuid binary from giving back
#            NET_ADMIN and SETPCAP. The probe binaries are made here, before the drop (a job holds
#            no SETFCAP and no mount), on a tmpfs that allows exec and setuid.
#
#   scripts/run_privileged_offline.sh [pytest arguments]
#
# The pinned OpenCode is fetched and verified first, outside the namespace (the one step that needs
# the internet, like the tiktoken cache of the engine suite).
set -euo pipefail
cd "$(dirname "$0")/.."

OPENCODE_BIN="$(uv run python scripts/fetch_opencode.py)"
for tool in rg nft setpriv unshare ip setcap; do
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
    # The writable paths of the container (#249): the same tmpfs options as compose.dynamic.yml
    # (`tmpfs`, pinned by app/src/ci/compose-dynamic.test.ts). A container mounts nothing from the
    # host: nothing of the /run of the CI host (its Docker socket among it) is visible to the suite,
    # and the AF_UNIX test (#244) judges the container. The HOME of the Diff job user is the CI
    # host'"'"'s own directory and cannot be hidden, so the suite gets a throwaway one in /tmp instead.
    mount -t tmpfs -o rw,noexec,nosuid,nodev,size=1m,mode=0755 tmpfs /run
    mount -t tmpfs -o rw,noexec,nosuid,nodev,size=512m,mode=1777 tmpfs /tmp
    HOME="$(mktemp -d)"
    export HOME
    export UV_CACHE_DIR="$HOME/uv-cache"
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
    # Where tests may run a copy of the engine: the container'"'"'s tmpfs are all noexec, the image'"'"'s
    # tools live in /usr/local/bin. A tmpfs of its own that allows exec (not suid, not dev), root only.
    CR_EXEC_DIR="$(mktemp -d)"
    export CR_EXEC_DIR
    mount -t tmpfs -o rw,exec,nosuid,nodev,size=1g,mode=0755 tmpfs "$CR_EXEC_DIR"
    # The probes of the execve phase: copies of `cat`, one with the file capabilities of the two
    # startup-only capabilities (permitted and inheritable, once with the effective flag too), one
    # setuid root, on a tmpfs that allows exec and setuid (the container'"'"'s own tmpfs allow neither).
    CR_PROBE_DIR="$(mktemp -d)"
    export CR_PROBE_DIR
    mount -t tmpfs -o rw,exec,suid,dev,size=8m,mode=0755 tmpfs "$CR_PROBE_DIR"
    for probe in cap-cat cap-cat-effective suid-cat; do
      cp "$(command -v cat)" "$CR_PROBE_DIR/$probe"
    done
    setcap cap_net_admin,cap_setpcap+ip "$CR_PROBE_DIR/cap-cat"
    setcap cap_net_admin,cap_setpcap+eip "$CR_PROBE_DIR/cap-cat-effective"
    chmod 4755 "$CR_PROBE_DIR/suid-cat"
    # The root filesystem is read-only, the last step of the set-up (it needs to write /etc): every
    # mount of a disk filesystem, so the repository, the tools and the system cannot be changed by
    # the suite however the CI host lays out its disks. tests/privileged/test_read_only_rootfs.py
    # proves the result.
    remount_failed=0
    while read -r mountpoint fstype; do
      case "$fstype" in
        ext2 | ext3 | ext4 | xfs | btrfs | vfat | overlay | fuseblk | squashfs | erofs | f2fs)
          mount -o remount,bind,ro "$mountpoint" \
            || { echo "could not make $mountpoint read-only" >&2; remount_failed=1; } ;;
      esac
    done < <(awk '"'"'{ for (i = 1; i <= NF; i++) if ($i == "-") print $5, $(i + 1) }'"'"' /proc/self/mountinfo)
    # A disk that stays writable would make the suite judge a layout the container does not have.
    [ "$remount_failed" = 0 ] || exit 1
    status=0
    setpriv \
      --bounding-set=-all,+chown,+dac_override,+fowner,+kill,+setgid,+setuid,+setpcap,+net_admin \
      --inh-caps=-all --no-new-privs \
      scripts/privileged_phases.sh "$@" || status=1
    # The execve phase: the same capabilities and the same startup step, but without no-new-privileges.
    PRIVILEGED_PHASE=job setpriv \
      --bounding-set=-all,+chown,+dac_override,+fowner,+kill,+setgid,+setuid,+setpcap,+net_admin \
      --inh-caps=-all \
      uv run --no-sync --offline python tests/privileged/execve_phase.py || status=1
    exit "$status"
  ' privileged "$@"
