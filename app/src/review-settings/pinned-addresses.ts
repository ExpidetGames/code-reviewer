// SPDX-License-Identifier: Apache-2.0

// The addresses the projects of one workspace pinned for a catalog provider (#588). The key test of that provider holds to them:
// a key is not tested at an address the workspace did not select. Pure over a workspace-scoped projects repository.
import type { ProjectsRepository } from "../db/repositories/projects-repository.ts";
import { parseStoredProjectDynamicOverrides } from "./validate.ts";

/** Reads the distinct pins of the projects of the repository's workspace that select `slug` as their Dynamic provider. */
export function createPinnedAddressReader(
  projects: Pick<ProjectsRepository, "list">,
): (slug: string) => Promise<string[]> {
  return async (slug) => {
    const pins = new Set<string>();
    for (const entry of await projects.list()) {
      if (entry.project === null) continue;
      const stored = parseStoredProjectDynamicOverrides(entry.project.settings);
      if (
        stored.dynamicProvider === slug &&
        stored.dynamicProviderAddress !== undefined
      )
        pins.add(stored.dynamicProviderAddress);
    }
    return [...pins];
  };
}
