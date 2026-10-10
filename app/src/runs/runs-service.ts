// The runs for the pages: which runs exist, one run, and the last run of each repository. A thin layer
// over the read side of the jobs table (`runs-repository.ts`) that turns stored jobs into the views
// the browser may see (`run-view.ts`) and checks what comes in from a URL. The clock is passed in so a
// test fixes the time a running run's duration is counted to.
import "server-only";
import type { RunsRepository } from "../db/repositories/runs-repository.ts";
import type { LastRun, LastRunSource } from "../projects/ui/list-view.ts";
import { isRunStatus } from "./run-status.ts";
import {
  toRunDetailView,
  toRunRowView,
  type RunDetailSnapshot,
  type RunsFilter,
  type RunsSnapshot,
} from "./run-view.ts";

/** How many runs the list shows at most. */
export const RUNS_LIST_LIMIT = 100;

/** What a request may ask the list for. A value that is not valid is refused, not ignored. */
export type RunsFilterInput = {
  repositoryId?: string | undefined;
  status?: string | undefined;
};

export type ParsedRunsFilter = { ok: true; filter: RunsFilter } | { ok: false };

const MAX_ID_LENGTH = 128;
const RUN_ID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** An empty value means "no filter"; an unknown status or an odd repository id is invalid. */
export function parseRunsFilter(input: RunsFilterInput): ParsedRunsFilter {
  const { repositoryId, status } = input;
  if (
    repositoryId !== undefined &&
    repositoryId !== "" &&
    (repositoryId.length > MAX_ID_LENGTH || repositoryId.trim() === "")
  )
    return { ok: false };
  if (status !== undefined && status !== "" && !isRunStatus(status))
    return { ok: false };
  return {
    ok: true,
    filter: {
      ...(repositoryId === undefined || repositoryId === ""
        ? {}
        : { repositoryId }),
      ...(status === undefined || status === "" || !isRunStatus(status)
        ? {}
        : { status }),
    },
  };
}

export type RunsService = {
  list(filter: RunsFilter): Promise<RunsSnapshot>;
  /** undefined for an id that is not a run id or that nobody has. */
  get(id: string): Promise<RunDetailSnapshot | undefined>;
};

export function createRunsService(deps: {
  runs: RunsRepository;
  now?: () => Date;
  /** Takes secrets out of a log before it is shown. */
  redact?: (text: string) => string;
}): RunsService {
  const now = deps.now ?? (() => new Date());
  return {
    async list(filter) {
      const answeredAt = now();
      const { runs, hasMore } = await deps.runs.list({
        ...filter,
        limit: RUNS_LIST_LIMIT,
      });
      return {
        generatedAt: answeredAt.toISOString(),
        runs: runs.map(({ job, project }) =>
          toRunRowView(job, project, answeredAt),
        ),
        limited: hasMore,
      };
    },

    async get(id) {
      if (!RUN_ID.test(id)) return undefined;
      const answeredAt = now();
      const stored = await deps.runs.get(id);
      if (stored === undefined) return undefined;
      return {
        generatedAt: answeredAt.toISOString(),
        run: toRunDetailView(
          stored.job,
          stored.project,
          answeredAt,
          deps.redact,
        ),
      };
    },
  };
}

/**
 * The last run of each repository for the project list: its newest job, whatever its status, with the
 * time it last changed (when it finished, else when it started, else when it was queued).
 */
export function createLastRunSource(deps: {
  runs: RunsRepository;
}): LastRunSource {
  return async (repositoryIds) => {
    const jobs = await deps.runs.latestPerRepository(repositoryIds);
    return new Map<string, LastRun>(
      jobs.map((job) => [
        job.repositoryId,
        {
          status: job.status,
          at: job.finishedAt ?? job.claimedAt ?? job.createdAt,
        },
      ]),
    );
  };
}
