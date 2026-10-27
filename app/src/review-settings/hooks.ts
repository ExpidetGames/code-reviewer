// SPDX-License-Identifier: LicenseRef-Proprietary

// What other modules want to know about a project's review settings. #195 implements this hook to
// cancel the project's waiting reviews when the review kind changes; this module has no idea what a
// job is.
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import type { ProjectReviewKind } from "../job-kind/job-kind.ts";

export type ProjectSettingsChangedEvent = {
  projectId: string;
  repositoryId: string;
  /** The kind before the save (Diff Review when the project never set one). */
  previousKind: ProjectReviewKind;
  /** The kind after the save. */
  nextKind: ProjectReviewKind;
  /** True when the kind actually changed, so a caller can leave everything else alone. */
  kindChanged: boolean;
};

/** The review kind the workspace defaults hold changed (#676): every project that stores no kind of its own follows it. */
export type WorkspaceDefaultsKindChangedEvent = {
  /** The kind the projects that follow the defaults had before the save. */
  previousKind: ProjectReviewKind;
  /** The kind they have after it. */
  nextKind: ProjectReviewKind;
  /** The repositories of the projects that store no kind of their own. */
  followingRepositoryIds: readonly string[];
};

export interface ReviewSettingsHooks {
  /**
   * Called in the transaction that wrote the project settings, so the write and everything it
   * triggers commit or roll back together. Use `executor` for every query, never the outer connection
   * (see src/db/README.md). A rejection rolls the settings change back: the stored settings stay as
   * they were and the caller gets the error.
   */
  onProjectSettingsChanged(
    event: ProjectSettingsChangedEvent,
    executor: Kysely<Database>,
  ): Promise<void>;
  /**
   * Called in the transaction that wrote the workspace defaults when their review kind changed and projects follow it (#676), with
   * the same rules as `onProjectSettingsChanged`: use `executor` for every query; a rejection rolls the save back.
   */
  onWorkspaceDefaultsKindChanged?(
    event: WorkspaceDefaultsKindChangedEvent,
    executor: Kysely<Database>,
  ): Promise<void>;
}

/** The default until #195 plugs the job queue in. */
export const noopReviewSettingsHooks: ReviewSettingsHooks = {
  async onProjectSettingsChanged() {
    // Nothing reacts to a settings change yet.
  },
};
