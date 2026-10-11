// The list of repositories on the Projects page: name (a link to the settings, also while the
// repository is inactive), installation, state, the status of the last run and the switch. Everything that
// comes from GitHub (names, addresses) is untrusted and rendered as text.
import Link from "next/link";
import { formatUtc } from "../../ui/format-time.ts";
import { NoRepositories } from "./no-repositories.tsx";
import { ProjectToggle } from "./project-toggle.tsx";
import type { ProjectsApi } from "./api.ts";
import { RUN_STATUS_PRESENTATION } from "../../runs/run-status.ts";
import type { LastRun, ProjectListView, ProjectRowView } from "./list-view.ts";

const STATE_COPY: Record<ProjectRowView["status"], string> = {
  active: "Active",
  inactive: "Inactive",
  unavailable: "Unavailable",
};

function LastRunStatus({
  run,
  repositoryId,
}: {
  run: LastRun | null;
  repositoryId: string;
}) {
  if (run === null) return <span className="muted">No run yet</span>;
  return (
    <span>
      {RUN_STATUS_PRESENTATION[run.status].label}{" "}
      <time dateTime={run.at} className="muted">
        {formatUtc(run.at)}
      </time>{" "}
      <Link href={`/runs?repository=${encodeURIComponent(repositoryId)}`}>
        All runs
      </Link>
    </span>
  );
}

function blockedReasonOf(
  row: ProjectRowView,
  activationBlocked: string | null,
): string | null {
  if (row.status === "unavailable")
    return "The GitHub App can no longer read this repository.";
  return activationBlocked;
}

export function ProjectList({
  view,
  installUrl,
  activationBlocked,
  api,
}: {
  view: ProjectListView;
  installUrl: string | null;
  /** Why no project can be switched on right now (the GitHub App is not configured), or null. */
  activationBlocked: string | null;
  api?: ProjectsApi;
}) {
  if (view.rows.length === 0) return <NoRepositories installUrl={installUrl} />;
  return (
    <ul className="project-list" aria-label="Repositories">
      {view.rows.map((row) => (
        <li key={row.repositoryId} className="project-row">
          <div className="project-main">
            <Link
              href={`/projects/${encodeURIComponent(row.repositoryId)}`}
              className="project-name"
            >
              {row.fullName}
            </Link>
            <span className="muted small">
              Installation: {row.installation}
              {row.url !== null ? (
                <>
                  {" "}
                  &middot;{" "}
                  <a
                    href={row.url}
                    rel="noreferrer noopener"
                    target="_blank"
                    aria-label={`${row.fullName} on GitHub`}
                  >
                    On GitHub
                  </a>
                </>
              ) : null}
            </span>
          </div>
          <div className="project-status">
            <span className={`badge badge-${row.status}`}>
              {STATE_COPY[row.status]}
            </span>
            <span className="small">
              Last run:{" "}
              <LastRunStatus
                run={row.lastRun}
                repositoryId={row.repositoryId}
              />
            </span>
            {row.status === "unavailable" && row.switchedOn ? (
              <span className="muted small">
                It was on and resumes if the repository comes back.
              </span>
            ) : null}
          </div>
          <ProjectToggle
            key={`${row.repositoryId}:${String(row.switchedOn)}`}
            repositoryId={row.repositoryId}
            fullName={row.fullName}
            checked={row.switchedOn}
            blockedReason={blockedReasonOf(row, activationBlocked)}
            {...(api === undefined ? {} : { api })}
          />
        </li>
      ))}
    </ul>
  );
}
