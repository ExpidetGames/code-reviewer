// SPDX-License-Identifier: Apache-2.0

// The last word of the network guard of the privileged Dynamic e2e lane (#253): prints the counters and exits
// 1 when anything of the lane reached for something that is not on loopback, whatever test it was. Run as
// root by runner/scripts/dynamic_e2e_namespace.sh after the journeys, in the lane's network namespace.
import { assertNoExternalAttempts, readGuard } from "./dynamic-lane-guard.ts";

try {
  const reading = readGuard();
  process.stdout.write(`${JSON.stringify(reading)}\n`);
  assertNoExternalAttempts(reading);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
