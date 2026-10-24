// SPDX-License-Identifier: LicenseRef-Proprietary

// A module that imports process spawning, so the bundle test can prove its detector finds it.
import { spawn } from "node:child_process";

export const spawner = spawn;
