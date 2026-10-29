// SPDX-License-Identifier: LicenseRef-Proprietary

// The last word of the network guard of the privileged Dynamic e2e lane (#253): prints the counters and exits
// 1 when anything of the lane reached for something that is not on loopback, whatever test it was, or when the lane's own
// resolver was asked for something it should not be (#714: any query by the engine user, any name that is not on
// e2e/dynamic/dns-allowlist.txt). Run as root by runner/scripts/dynamic_e2e_namespace.sh after the journeys, in the lane's
// network namespace, once the resolver has ended; its log is the optional argument.
import {
  LANE_DNS_LOG,
  assertDnsQuiet,
  assertNoExternalAttempts,
  describeAttempts,
  readAskedNames,
  readDns,
  readDnsAllowlist,
  readGuard,
  readGuardDestinations,
} from "./dynamic-lane-guard.ts";

const problems: string[] = [];
function check(verdict: () => void): void {
  try {
    verdict();
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
}

try {
  const reading = readGuard();
  const dns = readDns();
  process.stdout.write(`${JSON.stringify({ ...reading, dns })}\n`);
  check(() => {
    assertNoExternalAttempts(
      reading,
      describeAttempts(reading).length === 0 ? [] : readGuardDestinations(),
    );
  });
  check(() => {
    assertDnsQuiet(
      dns,
      readAskedNames(process.argv[2] ?? LANE_DNS_LOG),
      readDnsAllowlist(),
    );
  });
} catch (error) {
  problems.push(error instanceof Error ? error.message : String(error));
}
if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.exitCode = 1;
}
