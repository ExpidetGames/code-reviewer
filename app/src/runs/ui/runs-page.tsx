// The content of the Runs page: the filter, then the list. `loadRunsPage` gathers the data from the
// services (passed in, so a test uses real ones against a test database), `RunsPageContent` renders
// it. The page file only wires the real services. The filter is the address (`?repository=...&status=...`),
// so it survives a reload and the back button, and a page that stays mounted behind another one
// (Cache Components) shows the filter of its own address.
import Link from "next/link";
import type { JobStatus } from "../../jobs/job-status.ts";
import type { ProjectService } from "../../projects/service.ts";
import { EmptyState } from "../../ui/empty-state.tsx";
import { RUN_STATUS_ORDER, RUN_STATUS_PRESENTATION } from "../run-status.ts";
import { parseRunsFilter, type RunsService } from "../runs-service.ts";
import type { RunsSnapshot } from "../run-view.ts";
import type { RunsApi, RunsFilter } from "./api.ts";
import { RunsList } from "./runs-list.tsx";

export type RunsPageData =
  | { kind: "invalid_filter" }
  | {
      kind: "ready";
      filter: RunsFilter;
      snapshot: RunsSnapshot;
      /** The projects the filter offers: repositories that have a project. */
      projects: { id: string; name: string }[];
    };

/** The first value of a query parameter (a repeated one counts once). */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function loadRunsPage(
  searchParams: Record<string, string | string[] | undefined>,
  deps: {
    runs: Pick<RunsService, "list">;
    projects: Pick<ProjectService, "listProjects">;
  },
): Promise<RunsPageData> {
  const parsed = parseRunsFilter({
    repositoryId: first(searchParams.repository),
    status: first(searchParams.status),
  });
  if (!parsed.ok) return { kind: "invalid_filter" };
  const { filter } = parsed;
  const [snapshot, entries] = await Promise.all([
    deps.runs.list(filter),
    deps.projects.listProjects(),
  ]);
  return {
    kind: "ready",
    filter,
    snapshot,
    projects: entries
      .filter((entry) => entry.project !== null)
      .map((entry) => ({
        id: entry.repository.id,
        name: entry.repository.fullName,
      })),
  };
}

function filterKey(filter: RunsFilter): string {
  return `${filter.repositoryId ?? ""}|${filter.status ?? ""}`;
}

function RunsFilterForm({
  filter,
  projects,
}: {
  filter: RunsFilter;
  projects: { id: string; name: string }[];
}) {
  const active =
    filter.repositoryId !== undefined || filter.status !== undefined;
  return (
    <form method="get" action="/runs" className="runs-filter">
      <label>
        Project
        <select name="repository" defaultValue={filter.repositoryId ?? ""}>
          <option value="">All projects</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Status
        <select name="status" defaultValue={filter.status ?? ""}>
          <option value="">All statuses</option>
          {RUN_STATUS_ORDER.map((status: JobStatus) => (
            <option key={status} value={status}>
              {RUN_STATUS_PRESENTATION[status].label}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="btn btn-secondary">
        Apply filter
      </button>
      {active ? (
        <Link href="/runs" className="btn btn-ghost">
          Reset filter
        </Link>
      ) : null}
    </form>
  );
}

export function RunsPageContent({
  data,
  api,
}: {
  data: RunsPageData;
  /** Only tests pass this: a server component cannot hand functions to the client list. */
  api?: RunsApi;
}) {
  if (data.kind === "invalid_filter")
    return (
      <EmptyState
        title="This filter is not valid"
        action={
          <Link href="/runs" className="btn btn-secondary">
            Reset filter
          </Link>
        }
      >
        The project or status in the address is not one Code Reviewer knows.
      </EmptyState>
    );
  return (
    <>
      <RunsFilterForm filter={data.filter} projects={data.projects} />
      {/* Keyed on the filter: a page that stays mounted behind another one starts over when its
          address, and so its data, changes. */}
      <RunsList
        key={filterKey(data.filter)}
        initial={data.snapshot}
        filter={data.filter}
        {...(api === undefined ? {} : { api })}
      />
    </>
  );
}
