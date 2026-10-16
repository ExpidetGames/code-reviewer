// SPDX-License-Identifier: Apache-2.0

// The fake Launcher: it starts nothing and records what it was asked to start, so the core, the
// Triggers and the entry points are tested without a sandbox or a container. A test scripts a launch
// with `onLaunch` (resolve, reject with a LaunchError, wait for the abort, hang). Test use only.
import {
  CapabilitiesPending,
  type Engine,
  type LaunchSpec,
  type Launcher,
  type ProbeResult,
} from "../core/types.ts";

export type FakeLauncherOptions = {
  /** What `capabilities` answers; both engines by default. */
  engines?: readonly Engine[];
  /** `capabilities` rejects, as a failed probe would. */
  capabilitiesFail?: boolean;
  /** `capabilities` throws CapabilitiesPending (a probe is on its way) for this many seconds of retry. */
  capabilitiesPendingSeconds?: number;
  /** What a forced probe answers. Without it the fake has no `probe`, like a Launcher that proves nothing. */
  probe?: () => Promise<ProbeResult>;
  /** The behaviour of one launch; resolves at once by default. */
  onLaunch?: (spec: LaunchSpec, signal: AbortSignal) => Promise<void>;
};

export type FakeLauncher = Launcher & {
  /** Every launch asked for, in order. The credentials are dummy values of the fake App. */
  launches: LaunchSpec[];
  /** The abort signal each launch got. */
  signals: AbortSignal[];
  /** The engine each `capabilities` call said it needed, in order (undefined: any). */
  wanted: (Engine | undefined)[];
  /** How many forced probes were asked for. */
  probes: number;
};

export function createFakeLauncher(
  options: FakeLauncherOptions = {},
): FakeLauncher {
  const launches: LaunchSpec[] = [];
  const signals: AbortSignal[] = [];
  const wanted: (Engine | undefined)[] = [];
  const launcher: FakeLauncher = {
    launches,
    signals,
    wanted,
    probes: 0,
    capabilities(_signal, want) {
      wanted.push(want);
      if (options.capabilitiesPendingSeconds !== undefined)
        return Promise.reject(
          new CapabilitiesPending(options.capabilitiesPendingSeconds),
        );
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
  const probe = options.probe;
  if (probe !== undefined)
    launcher.probe = () => {
      launcher.probes += 1;
      return probe();
    };
  return launcher;
}
