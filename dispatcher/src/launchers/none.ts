// SPDX-License-Identifier: LicenseRef-Proprietary

// The Launcher of an entry point that has no real Launcher yet (the Sandbox-Launcher #329, the
// Docker-Launcher #334): it advertises no engine, so the Dispatcher claims nothing and answers every
// wake-up call "ignored, not_capable". Fail closed: never a Launcher that claims jobs and drops them.
import { LaunchError, type Launcher } from "../core/types.ts";

export const noLauncher: Launcher = {
  capabilities: () => Promise.resolve([]),
  launch: () => Promise.reject(new LaunchError("launcher_not_configured")),
};
