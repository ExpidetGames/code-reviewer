// What the project list shows, worked out from the project service: one row per repository the
// GitHub App can read (plus the ones that disappeared but kept a project), with its installation,
// its state and the status of its last run. Plain data: the components render it and the page only
// wires the services in, so nothing here depends on Next.js.
import type { ProjectStatus } from "../../db/repositories/projects-repository.ts";
import type { ProjectService } from "../service.ts";

/** The status of a run, as the jobs module names it (src/jobs). */
export const RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "superseded",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export type LastRun = {
  status: RunStatus;
  /** ISO 8601 time the run last changed (finished, or started when it is still going). */
  at: string;
};

/**
 * The last run of each repository, by repository id; a repository without a run is not in the map.
 * The jobs module provides the real source; until it is on this branch the list says "No run yet".
 */
export type LastRunSource = (
  repositoryIds: readonly string[],
) => Promise<ReadonlyMap<string, LastRun>>;

export const noRunsYet: LastRunSource = async () => new Map();

export type ProjectRowView = {
  repositoryId: string;
  fullName: string;
  /** The repository's address at the platform when it is a web address, otherwise null. */
  url: string | null;
  /** The installation the repository comes from (the account that installed the app). */
  installation: string;
  status: ProjectStatus;
  /** Whether the repository has a project at all (the settings page needs one). */
  hasProject: boolean;
  /** Whether the project is switched on (also for a repository that is unavailable). */
  switchedOn: boolean;
  lastRun: LastRun | null;
};

export type ProjectListView = { rows: ProjectRowView[] };

/** The address when it is an http(s) web address, otherwise null (never a `javascript:` link). */
export function webAddress(url: string): string | null {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "https:" || protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

export async function loadProjectList(deps: {
  projects: Pick<ProjectService, "listProjects">;
  lastRuns?: LastRunSource;
}): Promise<ProjectListView> {
  const entries = await deps.projects.listProjects();
  const lastRuns = await (deps.lastRuns ?? noRunsYet)(
    entries.map((entry) => entry.repository.id),
  );
  return {
    rows: entries.map(({ repository, project, status }) => ({
      repositoryId: repository.id,
      fullName: repository.fullName,
      url: webAddress(repository.url),
      installation: repository.integration.displayName,
      status,
      hasProject: project !== null,
      switchedOn: project?.active ?? false,
      lastRun: lastRuns.get(repository.id) ?? null,
    })),
  };
}
