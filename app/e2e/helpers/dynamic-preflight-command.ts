// SPDX-License-Identifier: LicenseRef-Proprietary

// The command of the preflight of the privileged Dynamic e2e lane (dynamic-preflight.ts): exit 0 when the
// lane can run, 1 with the missing items on stderr otherwise. Run by scripts/run_dynamic_e2e.sh first.
import { runPreflight } from "./dynamic-preflight.ts";

process.exitCode = runPreflight({
  LANE_OPENCODE_PATH: process.env.LANE_OPENCODE_PATH,
  LANE_RIPGREP_PATH: process.env.LANE_RIPGREP_PATH,
  LANE_ENGINE_UID: process.env.LANE_ENGINE_UID,
});
