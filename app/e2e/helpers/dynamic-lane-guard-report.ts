// SPDX-License-Identifier: LicenseRef-Proprietary

// Prints what the network guard of the privileged Dynamic e2e lane has counted so far and where the packets went (#667), before the
// journeys run: a violation counted here came from the lane's setup, not from a journey. It never fails; the verdict is the
// guard command's, after the journeys (dynamic-lane-guard-command.ts). Run as root by runner/scripts/dynamic_e2e_namespace.sh.
import { spawnSync } from "node:child_process";
import {
  readDns,
  readGuard,
  readGuardDestinations,
} from "./dynamic-lane-guard.ts";

try {
  process.stdout.write(
    `guard before the journeys: ${JSON.stringify({ ...readGuard(), dns: readDns() })} destinations: ${readGuardDestinations().join(", ")}\n`,
  );
} catch (error) {
  process.stdout.write(
    `guard before the journeys: not readable (${error instanceof Error ? error.message : String(error)})\n`,
  );
}

// TEMPORARY (#714): the raw listing, for the fixture of dynamic-lane-guard.test.ts; removed in the next commit.
process.stdout.write(
  `NFT-RAW-TABLE ${spawnSync("nft", ["-j", "list", "table", "inet", "cr_lane_guard"], { encoding: "utf8" }).stdout}\n`,
);
