// SPDX-License-Identifier: Apache-2.0

"use client";
// The filter of the Runs page (#175): a toolbar above the list whose state is the address, not a
// second copy in the component. The controls are controlled from the filter the server parsed out of
// the query string, so a reset, a reload or the Back button moves them without a remount key; picking
// a value writes the new query string with the client router. The choices are not ours (a project
// name comes from GitHub) and are rendered as text.
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "../../components/button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.tsx";
import { workspacePath } from "../../workspaces/paths.ts";
import { RUN_STATUS_ORDER, RUN_STATUS_PRESENTATION } from "../run-status.ts";
import type { RunsFilter } from "../run-view.ts";

/** The value of a select that means "do not filter by this field" (Radix reserves the empty string). */
const ANY = "any";

/** The Runs page of a workspace, without the filter. */
export function runsPath(workspaceSlug: string): string {
  return workspacePath(workspaceSlug, "/runs");
}

export function RunsFilterToolbar({
  workspaceSlug,
  filter,
  projects,
}: {
  /** The workspace of the page: the filter stays in it. */
  workspaceSlug: string;
  /** The filter the server read from the query string. */
  filter: RunsFilter;
  /** The projects the filter offers. */
  projects: { id: string; name: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  function apply(next: RunsFilter): void {
    const params = new URLSearchParams();
    if (next.repositoryId !== undefined)
      params.set("repository", next.repositoryId);
    if (next.status !== undefined) params.set("status", next.status);
    const query = params.toString();
    const href = query === "" ? pathname : `${pathname}?${query}`;
    // `push` (not `replace`): the Back button walks the filters a person tried, like the GET form did.
    startTransition(() => router.push(href, { scroll: false }));
  }

  const active =
    filter.repositoryId !== undefined || filter.status !== undefined;
  return (
    <div
      className="flex flex-wrap items-end gap-3"
      aria-busy={pending || undefined}
    >
      <Select
        value={filter.repositoryId ?? ANY}
        onValueChange={(value) =>
          apply({
            ...filter,
            repositoryId: value === ANY ? undefined : value,
          })
        }
      >
        <SelectTrigger aria-label="Project" className="min-w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>All projects</SelectItem>
          {projects.map((project) => (
            <SelectItem key={project.id} value={project.id}>
              {project.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={filter.status ?? ANY}
        onValueChange={(value) =>
          apply({
            ...filter,
            status: value === ANY ? undefined : (value as RunsFilter["status"]),
          })
        }
      >
        <SelectTrigger aria-label="Status" className="min-w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>All statuses</SelectItem>
          {RUN_STATUS_ORDER.map((status) => (
            <SelectItem key={status} value={status}>
              {RUN_STATUS_PRESENTATION[status].label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {active ? (
        <Button asChild variant="ghost">
          <Link href={runsPath(workspaceSlug)}>Reset filter</Link>
        </Button>
      ) : null}
    </div>
  );
}
