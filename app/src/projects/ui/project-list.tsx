// SPDX-License-Identifier: Apache-2.0

// The list of repositories on the Projects page, as a compact table: name (a link to the settings,
// also while the repository is inactive), installation, state, the status of the last run and the
// switch. Everything that comes from GitHub (names, addresses) is untrusted and rendered as text; a
// long name truncates instead of widening the page.
import Link from "next/link";
import { Badge } from "../../components/ui/badge.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx";
import { workspacePath } from "../../workspaces/paths.ts";
import { formatUtc } from "../../ui/format-time.ts";
import { NoRepositories } from "./no-repositories.tsx";
import { ProjectToggle } from "./project-toggle.tsx";
import type { ProjectsApi } from "./api.ts";
import { PROJECT_STATE_LABEL } from "./messages.ts";
import { RUN_STATUS_PRESENTATION } from "../../runs/run-status.ts";
import type { LastRun, ProjectListView, ProjectRowView } from "./list-view.ts";

function LastRunStatus({
  run,
  repositoryId,
  workspaceSlug,
}: {
  run: LastRun | null;
  repositoryId: string;
  workspaceSlug: string;
}) {
  if (run === null)
    return <span className="text-muted-foreground">No run yet</span>;
  return (
    <span>
      {RUN_STATUS_PRESENTATION[run.status].label}{" "}
      <time dateTime={run.at} className="text-muted-foreground">
        {formatUtc(run.at)}
      </time>{" "}
      <Link
        className="text-primary underline-offset-4 hover:underline"
        href={workspacePath(
          workspaceSlug,
          `/runs?repository=${encodeURIComponent(repositoryId)}`,
        )}
      >
        All runs
      </Link>
    </span>
  );
}

function stateBadgeVariant(status: ProjectRowView["status"]) {
  if (status === "active") return "success" as const;
  if (status === "unavailable") return "warning" as const;
  return "neutral" as const;
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
  workspaceSlug,
  canManage = true,
  canConnect = true,
  view,
  activationBlocked,
  api,
}: {
  /** The workspace of the page: every link and call stays in it. */
  workspaceSlug: string;
  /** Whether the person may switch projects on and off (an Admin or an Owner). */
  canManage?: boolean;
  /** Whether the person may connect GitHub (an Admin or an Owner). */
  canConnect?: boolean;
  view: ProjectListView;
  /** Why no project can be switched on right now (the GitHub App is not configured), or null. */
  activationBlocked: string | null;
  api?: ProjectsApi;
}) {
  if (view.rows.length === 0)
    return (
      <NoRepositories
        connectionsPath={workspacePath(workspaceSlug, "/connections")}
        canConnect={canConnect}
      />
    );
  return (
    <Table aria-label="Repositories" className="table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead className="w-[38%]">Name</TableHead>
          <TableHead className="w-[16%]">Installation</TableHead>
          <TableHead className="w-[12%]">Status</TableHead>
          <TableHead className="w-[26%]">Last run</TableHead>
          <TableHead className="w-[8%]">
            <span className="sr-only">Review</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {view.rows.map((row) => (
          <TableRow key={row.repositoryId}>
            <TableCell className="min-w-0 align-top whitespace-normal">
              <Link
                href={workspacePath(
                  workspaceSlug,
                  `/projects/${encodeURIComponent(row.repositoryId)}`,
                )}
                className="block truncate font-medium text-foreground"
              >
                {row.fullName}
              </Link>
              {row.url !== null ? (
                <a
                  href={row.url}
                  rel="noreferrer noopener"
                  target="_blank"
                  aria-label={`${row.fullName} on GitHub`}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  On GitHub
                </a>
              ) : null}
            </TableCell>
            <TableCell className="align-top text-muted-foreground">
              {row.installation}
            </TableCell>
            <TableCell className="align-top">
              <Badge variant={stateBadgeVariant(row.status)}>
                {PROJECT_STATE_LABEL[row.status]}
              </Badge>
            </TableCell>
            <TableCell className="align-top whitespace-normal">
              <LastRunStatus
                run={row.lastRun}
                repositoryId={row.repositoryId}
                workspaceSlug={workspaceSlug}
              />
              {row.status === "unavailable" && row.switchedOn ? (
                <p className="text-xs text-muted-foreground">
                  It was on and resumes if the repository comes back.
                </p>
              ) : null}
            </TableCell>
            <TableCell className="align-top">
              <ProjectToggle
                key={`${row.repositoryId}:${String(row.switchedOn)}`}
                workspaceSlug={workspaceSlug}
                canManage={canManage}
                repositoryId={row.repositoryId}
                fullName={row.fullName}
                checked={row.switchedOn}
                blockedReason={blockedReasonOf(row, activationBlocked)}
                {...(api === undefined ? {} : { api })}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
