// SPDX-License-Identifier: Apache-2.0

// A Launcher behind the capability probe (#331): `opencode` is advertised only while a fresh probe proved it,
// whatever the Launcher underneath says about itself; everything else (PR-Agent, the launch) is the Launcher's.
//
//   capabilities(signal, want)
//     want = pr-agent   the Launcher's engines without opencode, at once: a Diff job never waits for a probe
//     proof is fresh    the Launcher's engines, plus opencode if (and only if) the proof passed
//     no proof          the probe is started in the background (`background`: waitUntil on the platform) and
//                       - want = opencode   CapabilitiesPending: the core answers "unavailable, ask again"
//                       - want = anything   the Launcher's engines without opencode
//     proof `failed`    (no verdict: the platform, a timeout) want = opencode: CapabilitiesPending until the failure time
//                       is over, so the App retries with its back-off; a transient error must not look like "not capable",
//                       which the App stops resending for ten minutes. `denied` (the container's own answer): not capable.
//   launch(spec)        a Dynamic job is launched only while a pass still counts (defence in depth: the Worker proves it
//                       again itself)
//   probe(signal)       forces a probe (or joins the running one) and reports it: POST /probe, the deploy canary
//
// Platform-free: the probe's run is the part that knows a platform.
import type {
  Engine,
  LaunchSpec,
  Launcher,
  ProbeResult,
} from "../core/types.ts";
import { CapabilitiesPending, LaunchError } from "../core/types.ts";
import type { CapabilityProbe, ProbeOutcome } from "./capability-probe.ts";

/** How long the App is asked to wait before it asks again while the first probe runs (a canary VM takes a while). */
export const PENDING_RETRY_SECONDS = 20;

export type CapabilityProbeLauncherOptions = {
  launcher: Launcher;
  probe: CapabilityProbe;
  /** Keeps the probe going after the answer is sent: `waitUntil` on the platform, the tracker of the Node entry. */
  background?: (work: Promise<unknown>) => void;
  pendingRetrySeconds?: number;
  /** Milliseconds on the probe's clock (epoch milliseconds in production). */
  now?: () => number;
};

function reportOf(outcome: ProbeOutcome): ProbeResult {
  return {
    status: outcome.status,
    engines: outcome.engines,
    reasons: outcome.reasons,
    ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
    // The probe's clock is epoch milliseconds.
    checkedAt: new Date(outcome.checkedAt).toISOString(),
  };
}

export function withCapabilityProbe(
  options: CapabilityProbeLauncherOptions,
): Launcher {
  const { launcher, probe } = options;
  const pendingSeconds = options.pendingRetrySeconds ?? PENDING_RETRY_SECONDS;
  const now = options.now ?? (() => Date.now());

  /** The Launcher's own engines; its word about `opencode` is never taken. */
  async function own(signal: AbortSignal, want?: Engine): Promise<Engine[]> {
    return (await launcher.capabilities(signal, want)).filter(
      (engine) => engine !== "opencode",
    );
  }

  return {
    async capabilities(signal, want) {
      const engines = await own(signal, want);
      if (want === "pr-agent") return engines;
      const outcome = probe.fresh();
      if (outcome === undefined) {
        const started = probe.ensure();
        if (started !== undefined) options.background?.(started);
        if (want === "opencode") throw new CapabilitiesPending(pendingSeconds);
        return engines;
      }
      if (outcome.status === "failed" && want === "opencode")
        // What is left of the failure time, and at least the usual retry time.
        throw new CapabilitiesPending(
          Math.max(
            pendingSeconds,
            Math.ceil((outcome.expiresAt - now()) / 1000),
          ),
        );
      return outcome.status === "passed" ? [...engines, "opencode"] : engines;
    },

    launch(spec: LaunchSpec, signal) {
      if (spec.kind === "dynamic" && probe.fresh()?.status !== "passed")
        return Promise.reject(
          new LaunchError("capability_not_proven", { retryable: true }),
        );
      return launcher.launch(spec, signal);
    },

    async probe() {
      return reportOf(await probe.force());
    },
  };
}
