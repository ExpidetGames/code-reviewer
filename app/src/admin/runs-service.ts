// SPDX-License-Identifier: Apache-2.0

// The runs the instance admin looks at (#541): the newest jobs of every workspace, and one job with what it
// consumed and the trace of its calls. The admin is the operator who pays for the runs, so the cost is shown in
// full; the log of a run, the question of an `/ask` and the lease never leave the server on this path (the
// admin looks at what a run did, not at what the repository said). Everything is read through the job
// directory (`job-directory-repository.ts`), which only reads.
import "server-only";
import type {
  DirectoryRunRow,
  JobDirectoryRepository,
} from "../db/repositories/job-directory-repository.ts";
import { parseJobId } from "../runner-api/requests.ts";
import { runDurationMs } from "../runs/run-duration.ts";
import { toRunDetailView, type RunDetailView } from "../runs/run-view.ts";

/** How many runs the list shows at most. */
export const ADMIN_RUNS_LIST_LIMIT = 100;

export type AdminRunRowView = Pick<
  DirectoryRunRow,
  | "id"
  | "workspaceSlug"
  | "workspaceName"
  | "project"
  | "prNumber"
  | "reviewKind"
  | "status"
  | "createdAt"
  | "errorCode"
> & { durationMs: number | null };

export type AdminRunsListView = { runs: AdminRunRowView[]; hasMore: boolean };

export type AdminRunDetailView = {
  workspaceSlug: string;
  workspaceName: string;
  /** The run as the Runs page of a workspace knows it, without the log and the question of an `/ask`. */
  run: Omit<RunDetailView, "log" | "args">;
};

export type AdminRunsService = {
  list(): Promise<AdminRunsListView>;
  /** undefined for an id that is not a job id or that nobody has. */
  get(id: string): Promise<AdminRunDetailView | undefined>;
};

export function createAdminRunsService(deps: {
  directory: JobDirectoryRepository;
  /** Removes secrets from the text of a view (the second line of defense after the runner). */
  redact?: (text: string) => string;
  now?: () => Date;
}): AdminRunsService {
  const redact = deps.redact ?? ((text: string) => text);
  const now = deps.now ?? (() => new Date());
  return {
    async list() {
      const { runs, hasMore } = await deps.directory.list(
        ADMIN_RUNS_LIST_LIMIT,
      );
      const at = now();
      return {
        runs: runs.map((row) => ({
          id: row.id,
          workspaceSlug: row.workspaceSlug,
          workspaceName: row.workspaceName,
          project: row.project,
          prNumber: row.prNumber,
          reviewKind: row.reviewKind,
          status: row.status,
          createdAt: row.createdAt,
          durationMs: runDurationMs(
            {
              status: row.status,
              startedAt: row.claimedAt,
              finishedAt: row.finishedAt,
            },
            at,
          ),
          errorCode: row.errorCode,
        })),
        hasMore,
      };
    },

    async get(id) {
      if (!parseJobId(id)) return undefined;
      const stored = await deps.directory.get(id);
      if (stored === undefined) return undefined;
      // Left out on purpose: the log and the question are what the repository said, not what the run did.
      const { log, args, ...run } = toRunDetailView(
        stored.job,
        stored.project,
        now(),
        redact,
        false,
      );
      void [log, args];
      return {
        workspaceSlug: stored.workspaceSlug,
        workspaceName: stored.workspaceName,
        run,
      };
    },
  };
}
