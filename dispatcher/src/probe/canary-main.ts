// SPDX-License-Identifier: Apache-2.0

// `pnpm probe:canary --url <dispatcher>`: the command of the deploy canary (canary.ts), for a step of the release
// pipeline. The credential is `RUNNER_TOKEN` in the environment.
import { systemClock } from "../core/clock.ts";
import { CanaryUsageError, parseCanaryArguments, runCanary } from "./canary.ts";

try {
  const options = parseCanaryArguments(process.argv.slice(2), process.env);
  process.exitCode = await runCanary({
    ...options,
    clock: systemClock,
    write: (line) => console.log(line),
  });
} catch (error) {
  if (!(error instanceof CanaryUsageError)) throw error;
  console.error(`canary: ${error.message}`);
  process.exitCode = 2;
}
