// SPDX-License-Identifier: LicenseRef-Proprietary

// Gives a Launcher the `probe` that `POST /probe` calls, the deploy canary (#331, #479). Only that: `capabilities` and
// `launch` are the Launcher's own, so a Dynamic job is never held back by a probe and never starts a canary VM. The
// proof that a deployment may run Dynamic jobs is the canary that passed before the deployment went live.
//
//   probe(signal)   forces a probe (or joins the running one) and reports it
//
// Platform-free: the probe's run is the part that knows a platform.
import type { Launcher, ProbeResult } from "../core/types.ts";
import type { CapabilityProbe, ProbeOutcome } from "./capability-probe.ts";

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

export function withProbeEndpoint(options: {
  launcher: Launcher;
  probe: CapabilityProbe;
}): Launcher {
  const { launcher, probe } = options;
  return {
    ...launcher,
    async probe() {
      return reportOf(await probe.force());
    },
  };
}
