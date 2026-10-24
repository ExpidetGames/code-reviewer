// SPDX-License-Identifier: LicenseRef-Proprietary

// The addresses the projects of one workspace pinned for a catalog provider (#588). Two readers hold to them: the key test of that
// provider (a key is not tested at an address the workspace did not select) and the settings save (a pin another project of the
// workspace does not hold is written by an Owner or Admin only). Both read every project: a pin is dormant, not gone (#614).
// Pure over a workspace-scoped projects repository.
import type { ProjectsRepository } from "../db/repositories/projects-repository.ts";
import { builtInProjectDynamicSettings } from "./settings.ts";
import { parseStoredProjectDynamicOverrides } from "./validate.ts";

/** Which projects count. */
export type PinScope = {
  /**
   * Only the projects whose reviews use the provider now: switched on, listed by the platform, and Dynamic. Default: every project
   * that has the provider as its Dynamic provider, whatever its kind and state (a pin is dormant, not gone). No reader of the
   * server asks for this since #614 (a Member could switch a project to Diff to leave its pin out of the key test).
   */
  inUseOnly?: boolean;
  /** Leave out the project of this repository (the one being saved). */
  exceptRepositoryId?: string;
};

export type PinnedAddressReader = (
  slug: string,
  scope?: PinScope,
) => Promise<string[]>;

/** Reads the distinct pins of the projects of the repository's workspace that select `slug` as their Dynamic provider. */
export function createPinnedAddressReader(
  projects: Pick<ProjectsRepository, "list">,
): PinnedAddressReader {
  return async (slug, scope = {}) => {
    const pins = new Set<string>();
    for (const entry of await projects.list()) {
      if (entry.project === null) continue;
      if (entry.repository.id === scope.exceptRepositoryId) continue;
      const stored = parseStoredProjectDynamicOverrides(entry.project.settings);
      if (stored.dynamicProvider !== slug) continue;
      if (stored.dynamicProviderAddress === undefined) continue;
      if (
        scope.inUseOnly === true &&
        (entry.status !== "active" ||
          (stored.reviewKind ?? builtInProjectDynamicSettings().reviewKind) !==
            "dynamic")
      )
        continue;
      pins.add(stored.dynamicProviderAddress);
    }
    return [...pins];
  };
}
