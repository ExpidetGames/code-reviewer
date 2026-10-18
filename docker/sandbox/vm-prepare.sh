#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Per-VM-start preparation of a Sandbox VM before the first `docker run` (#325, spike #317 finding
# F1). Run it as root on EVERY start of a VM, before anything uses Docker: the golden snapshot
# (#330) installs it as /usr/local/sbin/vm-prepare.sh, the Sandbox-Launcher (#329) runs it. The
# snapshot stores files, not the cgroup state, so it cannot be done once at build time.
#
# Why: on the VM image the cgroup v2 root is in "domain threaded" mode (it holds tasks while cpuset,
# cpu and pids are enabled below it), so `memory` and `io` cannot be enabled and the cgroup that
# `dockerd` creates is threaded. `docker run` with --memory or --pids-limit, which every container
# of the hardened container spec has, then fails with "cannot enter cgroupv2 ... with domain
# controllers -- it is in threaded mode". The fix turns the root into a plain domain: it disables the
# threaded controllers, moves every process of the root into vm.slice and enables the controllers
# again. It takes about a second. Steps 1 and 2 are idempotent: a root that is already prepared and a
# daemon that already answers are left alone, and a failure is loud (set -e), so a VM that could not be prepared never runs a Worker.
#
# 1. make the cgroup v2 root a domain that can hold the memory controller
# 2. start dockerd detached and wait until `docker info` answers
#
# Step 1 is tried again (#473). The platform is still creating processes of the VM's own start in the root when
# the Launcher's first command arrives, and while the root holds a process the write that enables the controllers
# fails with "Device or resource busy". Run as the very first command after the VM was created, one try in two ended
# there; a try a moment later never did. Each try moves what is in the root again, so the late processes go too. When
# every try fails, stderr names the cause and the processes still in the root: the Dispatcher logs its tail.
# The three variables below exist for the test, which runs the script against a directory.
set -euo pipefail
cd "${VM_PREPARE_CGROUP_ROOT:-/sys/fs/cgroup}"
tries="${VM_PREPARE_TRIES:-100}"
pause="${VM_PREPARE_RETRY_SECONDS:-0.1}"

prepare_cgroup() {
  local p
  [ ! -d docker ] || rmdir docker/* docker 2>/dev/null || true
  echo "-cpuset -cpu -pids" > cgroup.subtree_control || return 1
  mkdir -p vm.slice
  for p in $(cat cgroup.procs); do echo "$p" > vm.slice/cgroup.procs 2>/dev/null || true; done
  echo "+memory +io +cpu +cpuset +pids" > cgroup.subtree_control
}

if [ "$(cat cgroup.type)" != "domain" ] || ! grep -qw memory cgroup.subtree_control; then
  prepared=0
  last_error=""
  for attempt in $(seq 1 "$tries"); do
    # The error text of the write is the bash's own, so it is collected here and not in the trace.
    if last_error="$(prepare_cgroup 2>&1)"; then prepared=1; break; fi
    sleep "$pause"
  done
  if [ "$prepared" != 1 ]; then
    echo "vm-prepare: cgroup_root_busy tries=$tries last_error=${last_error##*: }" >&2
    for p in $(cat cgroup.procs 2>/dev/null); do
      echo "vm-prepare: left_in_root $p:$(cat "/proc/$p/comm" 2>/dev/null || echo gone)" >&2
    done
    exit 1
  fi
fi
# A daemon that already answers (a second run in the same boot) is left alone: a second dockerd could not
# bind the socket and its redirect would truncate the log of the running one.
docker info >/dev/null 2>&1 && exit 0
nohup setsid dockerd > /var/log/dockerd.log 2>&1 &
for _ in $(seq 1 200); do docker info >/dev/null 2>&1 && exit 0; sleep 0.1; done
echo "vm-prepare: dockerd did not become ready" >&2; exit 1
