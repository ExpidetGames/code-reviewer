// SPDX-License-Identifier: Apache-2.0

// The command of the preflight of the privileged Dynamic e2e lane (dynamic-preflight.ts): exit 0 when the
// lane can run, 1 with the missing items on stderr otherwise. Run by scripts/run_dynamic_e2e.sh first.
import { runPreflight } from "./dynamic-preflight.ts";

process.exitCode = runPreflight(process.env);
