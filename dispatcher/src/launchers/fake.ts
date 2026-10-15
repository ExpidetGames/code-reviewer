// SPDX-License-Identifier: Apache-2.0

// The fake Launcher: it starts nothing and records what it was asked to start, so the core, the
// Triggers and the entry points are tested without a sandbox or a container. A test scripts a launch
// with `onLaunch` (resolve, reject with a LaunchError, wait for the abort, hang). Test use only.
import type { Engine, LaunchSpec, Launcher } from "../core/types.ts";

export type FakeLauncherOptions = {
  /** What `capabilities` answers; both engines by default. */
  engines?: readonly Engine[];
  /** `capabilities` rejects, as a failed probe would. */
  capabilitiesFail?: boolean;
  /** The behaviour of one launch; resolves at once by default. */
  onLaunch?: (spec: LaunchSpec, signal: AbortSignal) => Promise<void>;
};

export type FakeLauncher = Launcher & {
  /** Every launch asked for, in order. The credentials are dummy values of the fake App. */
  launches: LaunchSpec[];
  /** The abort signal each launch got. */
  signals: AbortSignal[];
};

export function createFakeLauncher(
  options: FakeLauncherOptions = {},
): FakeLauncher {
  const launches: LaunchSpec[] = [];
  const signals: AbortSignal[] = [];
  return {
    launches,
    signals,
    capabilities() {
      if (options.capabilitiesFail === true)
        return Promise.reject(new Error("the probe failed"));
      return Promise.resolve(options.engines ?? ["pr-agent", "opencode"]);
    },
    launch(spec, signal) {
      launches.push(spec);
      signals.push(signal);
      return options.onLaunch?.(spec, signal) ?? Promise.resolve();
    },
  };
}
