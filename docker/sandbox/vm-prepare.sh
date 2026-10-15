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
# again. It takes about a second. Steps 1 and 2 are idempotent: a root that is already prepared is
# left alone, and a failure is loud (set -e), so a VM that could not be prepared never runs a Worker.
#
# 1. make the cgroup v2 root a domain that can hold the memory controller
# 2. start dockerd detached and wait until `docker info` answers
set -euo pipefail
cd /sys/fs/cgroup
if [ "$(cat cgroup.type)" != "domain" ] || ! grep -qw memory cgroup.subtree_control; then
  [ ! -d docker ] || rmdir docker/* docker 2>/dev/null || true
  echo "-cpuset -cpu -pids" > cgroup.subtree_control
  mkdir -p vm.slice
  for p in $(cat cgroup.procs); do echo "$p" > vm.slice/cgroup.procs 2>/dev/null || true; done
  echo "+memory +io +cpu +cpuset +pids" > cgroup.subtree_control
fi
nohup setsid dockerd > /var/log/dockerd.log 2>&1 &
for _ in $(seq 1 200); do docker info >/dev/null 2>&1 && exit 0; sleep 0.1; done
echo "dockerd did not become ready" >&2; exit 1
