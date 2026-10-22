// SPDX-License-Identifier: Apache-2.0

// The shared header of the two project pages (#174): one h1 with the repository's full name and its
// state badge, the trail `Projects / <project> / Settings|Review now`, the primary action "Review now"
// on the settings page, and the segmented navigation between the two pages. The trail starts at the
// Projects list (the area root, epic #165 breadcrumb rule); the repository name is untrusted GitHub
// text and is rendered as text, never as markup.
import Link from "next/link";
import { Badge } from "../../components/ui/badge.tsx";
import { Breadcrumbs } from "../../components/breadcrumbs.tsx";
import { Button } from "../../components/button.tsx";
import { PageHeader } from "../../components/page-header.tsx";
import { cn } from "../../lib/utils.ts";
import { workspacePath } from "../../workspaces/paths.ts";
import type { ProjectRowView } from "./list-view.ts";
import { PROJECT_STATE_BADGE, PROJECT_STATE_LABEL } from "./messages.ts";

export type ProjectSection = "settings" | "review";

/** The settings page of a project. */
export function projectSettingsPath(
  workspaceSlug: string,
  repositoryId: string,
): string {
  return workspacePath(
    workspaceSlug,
    `/projects/${encodeURIComponent(repositoryId)}`,
  );
}

/** The manual-review page of a project. */
export function projectReviewPath(
  workspaceSlug: string,
  repositoryId: string,
): string {
  return `${projectSettingsPath(workspaceSlug, repositoryId)}/review`;
}

const SECTIONS: ReadonlyArray<{ value: ProjectSection; label: string }> = [
  { value: "settings", label: "Settings" },
  { value: "review", label: "Review now" },
];

/** The segmented navigation between the settings and the manual-review page of one project. */
export function ProjectSections({
  workspaceSlug,
  repositoryId,
  active,
}: {
  workspaceSlug: string;
  repositoryId: string;
  active: ProjectSection;
}) {
  return (
    <nav aria-label="Project" className="flex gap-1 border-b border-border">
      {SECTIONS.map((section) => {
        const current = section.value === active;
        return (
          <Link
            key={section.value}
            href={
              section.value === "settings"
                ? projectSettingsPath(workspaceSlug, repositoryId)
                : projectReviewPath(workspaceSlug, repositoryId)
            }
            aria-current={current ? "page" : undefined}
            className={cn(
              "inline-flex min-h-11 items-center border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground no-underline hover:text-foreground",
              current && "border-primary text-foreground",
            )}
          >
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function ProjectPageHeader({
  workspaceSlug,
  row,
  active,
}: {
  workspaceSlug: string;
  row: ProjectRowView;
  active: ProjectSection;
}) {
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={row.fullName}
        badge={
          <Badge variant={PROJECT_STATE_BADGE[row.status]}>
            {PROJECT_STATE_LABEL[row.status]}
          </Badge>
        }
        breadcrumb={
          <Breadcrumbs
            items={[
              {
                label: "Projects",
                href: workspacePath(workspaceSlug, "/projects"),
              },
              // The repository is the subject of the page, not a page of its own.
              { label: row.fullName },
              {
                label: active === "settings" ? "Settings" : "Review now",
              },
            ]}
          />
        }
        actions={
          active === "settings" ? (
            <Button asChild variant="secondary">
              <Link
                href={projectReviewPath(workspaceSlug, row.repositoryId)}
                aria-label={`Review ${row.fullName} now`}
              >
                Review now
              </Link>
            </Button>
          ) : null
        }
      />
      <ProjectSections
        workspaceSlug={workspaceSlug}
        repositoryId={row.repositoryId}
        active={active}
      />
    </div>
  );
}
