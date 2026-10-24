// SPDX-License-Identifier: LicenseRef-Proprietary

// Where the trigger policy gets the settings of a project from: the repository row of the delivery,
// then the review settings service (project over global over built-in). Kept apart from `shared.ts`
// so a test can wire the same lookup to a real database.
import type { RepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import type { ReviewSettingsService } from "../review-settings/service.ts";
import type { WorkspaceCollaborators } from "./github-app-handler.ts";

export function createAutomaticReviewSettingsSource(deps: {
  repositories: Pick<RepositoriesRepository, "findByExternalId">;
  settings: Pick<ReviewSettingsService, "resolveForRepository">;
}): WorkspaceCollaborators["settingsFor"] {
  return async (integrationId, repositoryExternalId) => {
    const repository = await deps.repositories.findByExternalId(
      integrationId,
      repositoryExternalId,
    );
    // A delivery can outrun the synchronization of the repository list; without a row there is no
    // project either, and the handler answers `project_not_active`.
    if (repository === undefined) return undefined;
    return (await deps.settings.resolveForRepository(repository.id))?.settings;
  };
}
