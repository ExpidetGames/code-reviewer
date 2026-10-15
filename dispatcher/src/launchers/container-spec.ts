// SPDX-License-Identifier: Apache-2.0

import type { WorkerContainerSpec } from "../contracts/worker-container.ts";

// The hardened container spec the launchers render (contracts/worker-container.v1.json, #316): the
// self-hosted default. It is the example spec of the contract, value for value; container-spec.test.ts
// fails when the two differ, and app/src/ci/worker-container-parity.test.ts fails when compose.dynamic.yml
// or the runner-dynamic service of compose.coolify.yml differ from the example. A change of a flag is
// therefore made in all of them in one pull request.
export const WORKER_CONTAINER_SPEC: WorkerContainerSpec = {
  version: 1,
  user: "0:0",
  capDrop: ["ALL"],
  capAdd: [
    { name: "SETUID", startupOnly: false },
    { name: "SETGID", startupOnly: false },
    { name: "KILL", startupOnly: false },
    { name: "CHOWN", startupOnly: false },
    { name: "DAC_OVERRIDE", startupOnly: false },
    { name: "FOWNER", startupOnly: false },
    { name: "NET_ADMIN", startupOnly: true },
    { name: "SETPCAP", startupOnly: true },
  ],
  securityOpt: ["no-new-privileges:true"],
  readOnly: true,
  tmpfs: [
    {
      path: "/tmp",
      options: ["rw", "noexec", "nosuid", "nodev"],
      size: "512m",
      mode: "1777",
    },
    {
      path: "/run",
      options: ["rw", "noexec", "nosuid", "nodev"],
      size: "1m",
      mode: "0755",
    },
    {
      path: "/home/runner",
      options: ["rw", "noexec", "nosuid", "nodev"],
      size: "64m",
      uid: 10001,
      gid: 10001,
      mode: "0700",
    },
  ],
  memory: { limit: "2g", reservation: "1536m", swap: "2g" },
  pids: { limit: 512 },
  stopTimeoutSeconds: 90,
  network: { mode: "bridge" },
  allowedEnvironment: [
    "HOME",
    "RUNNER_DIFF_JOB_USER",
    "RUNNER_JOB_TIMEOUT_SECONDS",
    "RUNNER_DYNAMIC_CAPABILITIES",
    "RUNNER_DYNAMIC_MAX_COST_USD",
  ],
  forbiddenKeys: [
    "privileged",
    "binds",
    "volumes",
    "devices",
    "networkMode",
    "pid",
    "ipc",
    "uts",
    "userns",
    "cgroupns",
    "dockerSocket",
  ],
  overridable: ["memory.limit", "memory.reservation", "memory.swap"],
};
