// SPDX-License-Identifier: Apache-2.0

// A module that imports process spawning, so the bundle test can prove its detector finds it.
import { spawn } from "node:child_process";

export const spawner = spawn;
