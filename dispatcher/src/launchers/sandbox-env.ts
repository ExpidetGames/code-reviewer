// SPDX-License-Identifier: Apache-2.0

// The Sandbox-Launcher from the environment, for the Vercel entry (#329). Names only; a refusal names the
// variable and never the value.
//
// | Variable                                           | Meaning                                                            | Default |
// |----------------------------------------------------|--------------------------------------------------------------------|---------|
// | SANDBOX_SNAPSHOT_ID                                | The golden snapshot (#330 record `snapshotId`)                     | none: no launcher, nothing is claimed |
// | SANDBOX_IMAGE_DIGEST                               | The Worker image id in it (#330 record `imageDigest`), `sha256:...` | required with the snapshot |
// | SANDBOX_HANDOVER_SECONDS                           | How long the container runs before the Worker counts as having taken over (1 to 120) | 20 |
// | SANDBOX_VM_TIMEOUT_MARGIN_SECONDS                 | Seconds added to the job's timeout for the VM's own (the backstop that ends a VM nobody stops); at least 180 and 150 more than the hand-over time, at most 3600 | 300 |
// | VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID    | Platform access by token. Without a token the OIDC token is used   | OIDC |
//
// VM size and container memory per Worker kind are part of DISPATCHER_WORKER_CONFIG (`launcher.vcpus`,
// `container.memory`), validated here at start.
import {
  ConfigError,
  integer,
  read,
  type Environment,
  type Settings,
} from "../config.ts";
import type { Launcher, Logger } from "../core/types.ts";
import { noLauncher } from "./none.ts";
import {
  LAUNCH_STEPS_SECONDS,
  createSandboxLauncher,
  minimumVmTimeoutMargin,
  validateKindConfig,
  VM_TIMEOUT_MARGIN_SECONDS,
} from "./sandbox.ts";
import {
  createVercelSandboxService,
  type SandboxSdk,
  type VercelCredentials,
} from "./vercel-sandbox.ts";

const SNAPSHOT_ID = /^[A-Za-z0-9_-]{3,128}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const PLAIN = /^[^\s\p{Cc}]+$/u;

export type LauncherContext = {
  settings: Settings;
  logger: Logger;
  /** `waitUntil` on the platform, the tracker of the Node entry. */
  background: (work: Promise<unknown>) => void;
};

export type SandboxFromEnvironment = {
  /** The launcher for a composed Dispatcher: the Sandbox-Launcher, or `noLauncher` when no snapshot is configured. */
  launcher: (context: LauncherContext) => Launcher;
  /** Secrets of this part of the configuration, for the logger's masker. */
  secrets: string[];
};

function credentials(env: Environment): VercelCredentials | undefined {
  const token = read(env, "VERCEL_TOKEN");
  if (token === undefined) return undefined;
  if (!PLAIN.test(token)) throw new ConfigError("VERCEL_TOKEN", "invalid");
  const teamId = read(env, "VERCEL_TEAM_ID");
  if (teamId === undefined) throw new ConfigError("VERCEL_TEAM_ID", "required");
  const projectId = read(env, "VERCEL_PROJECT_ID");
  if (projectId === undefined)
    throw new ConfigError("VERCEL_PROJECT_ID", "required");
  for (const [name, value] of [
    ["VERCEL_TEAM_ID", teamId],
    ["VERCEL_PROJECT_ID", projectId],
  ] as const)
    if (!PLAIN.test(value)) throw new ConfigError(name, "invalid");
  return { token, teamId, projectId };
}

export function sandboxFromEnvironment(
  env: Environment,
  loadSdk: () => Promise<SandboxSdk>,
): SandboxFromEnvironment {
  const snapshotId = read(env, "SANDBOX_SNAPSHOT_ID");
  const imageDigest = read(env, "SANDBOX_IMAGE_DIGEST");
  if (snapshotId === undefined && imageDigest === undefined)
    return { launcher: () => noLauncher, secrets: [] };

  // One without the other is a mistake, not "off": a Dispatcher that claims nothing would look healthy.
  if (snapshotId === undefined)
    throw new ConfigError("SANDBOX_SNAPSHOT_ID", "required");
  if (!SNAPSHOT_ID.test(snapshotId))
    throw new ConfigError("SANDBOX_SNAPSHOT_ID", "invalid");
  if (imageDigest === undefined)
    throw new ConfigError("SANDBOX_IMAGE_DIGEST", "required");
  if (!IMAGE_DIGEST.test(imageDigest))
    throw new ConfigError("SANDBOX_IMAGE_DIGEST", "invalid");
  const handoverSeconds = integer(env, "SANDBOX_HANDOVER_SECONDS", {
    min: 1,
    max: 120,
    fallback: 20,
  });
  const vmTimeoutMarginSeconds = integer(
    env,
    "SANDBOX_VM_TIMEOUT_MARGIN_SECONDS",
    { min: 1, max: 3600, fallback: VM_TIMEOUT_MARGIN_SECONDS },
  );
  if (vmTimeoutMarginSeconds < minimumVmTimeoutMargin(handoverSeconds))
    throw new ConfigError("SANDBOX_VM_TIMEOUT_MARGIN_SECONDS", "invalid");
  const access = credentials(env);
  const secrets = [access?.token, read(env, "VERCEL_OIDC_TOKEN")].filter(
    (secret): secret is string => secret !== undefined,
  );

  return {
    secrets,
    launcher({ settings, logger, background }) {
      // The launch has the core's deadline from the claim: the hand-over comes after create, the host preparation
      // and the image check, whose own timeouts add up to LAUNCH_STEPS_SECONDS.
      if (
        handoverSeconds + LAUNCH_STEPS_SECONDS >
        settings.core.launchDeadlineSeconds
      )
        throw new ConfigError("SANDBOX_HANDOVER_SECONDS", "invalid");
      for (const kind of ["diff", "dynamic"] as const) {
        try {
          validateKindConfig(kind, settings.core.workerConfig[kind]);
        } catch {
          throw new ConfigError("DISPATCHER_WORKER_CONFIG", "invalid");
        }
      }
      return createSandboxLauncher({
        service: createVercelSandboxService(loadSdk, access),
        snapshotId,
        imageDigest,
        handoverSeconds,
        vmTimeoutMarginSeconds,
        logger,
        background,
      });
    },
  };
}
