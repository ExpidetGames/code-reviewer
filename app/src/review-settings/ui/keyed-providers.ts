// SPDX-License-Identifier: Apache-2.0

// Which providers have a stored key in a workspace, as the plain list the settings form takes (#433). Kept out of the
// client components so that a server page can call it. The statuses never hold the key, only whether there is one.
import type { ProviderKeyStatus } from "../../llm/workspace-key.ts";

/** The ids of the providers whose key is stored and can be read; an unreadable key is as good as none. */
export function keyedProvidersOf(
  statuses: readonly ProviderKeyStatus[],
): string[] {
  return statuses
    .filter((entry) => entry.status.state === "configured")
    .map((entry) => entry.provider);
}
