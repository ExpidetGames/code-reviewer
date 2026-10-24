// SPDX-License-Identifier: LicenseRef-Proprietary

// The flags of the self-check probe container (#330): the arguments of `docker run` that the shared renderer of
// the hardened container spec (#325) makes for the Sandbox variant, never flags written here. That is the
// hardening of the `runner-dynamic` service of compose.coolify.yml plus the two IPv6 sysctls that the reduced
// egress ruleset needs (#345, SANDBOX_LAUNCHER_ADDITIONS). The probe is given no token, URL or credential, only the
// two variables its settings read, and the image's `probe` mode (#324) as its command.
import {
  SANDBOX_LAUNCHER_ADDITIONS,
  WORKER_CONTAINER_SPEC,
} from "../launchers/container-spec.ts";
import { renderDockerRunArguments } from "../launchers/container.ts";

/** The arguments after `docker`. Throws `ContainerSpecError` for a memory limit the spec does not allow. */
export function probeRunArguments(config: {
  imageTag: string;
  probeMemory: string;
}): string[] {
  return renderDockerRunArguments(WORKER_CONTAINER_SPEC, {
    image: config.imageTag,
    environment: {
      HOME: "/home/runner",
      RUNNER_DIFF_JOB_USER: "10001:10001",
    },
    command: ["probe"],
    overrides: {
      memory: { limit: config.probeMemory, swap: config.probeMemory },
    },
    additions: SANDBOX_LAUNCHER_ADDITIONS,
  });
}
