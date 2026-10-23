// SPDX-License-Identifier: Apache-2.0

"use client";
// The workspace switcher in the header: a DropdownMenu with the workspace the page is in (read from
// the address) as its label and every workspace the signed in person belongs to, each a link to that
// workspace. A person who may create workspaces (a multi-tenant instance) finds the link here too,
// and so do the waiting invitations. Only names and slugs of workspaces the person is a member of
// are ever passed in.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CaretDownIcon } from "@phosphor-icons/react/dist/ssr";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { workspaceHome, workspaceSlugOfPath } from "../workspaces/paths.ts";

export type SwitcherWorkspace = { slug: string; name: string };

export function WorkspaceSwitcher({
  workspaces,
  canCreate,
  pendingInvitations,
}: {
  workspaces: SwitcherWorkspace[];
  /** Whether the instance lets people create workspaces. */
  canCreate: boolean;
  /** How many invitations wait for the person (0 when none, or when the instance cannot list them). */
  pendingInvitations: number;
}) {
  const pathname = usePathname();
  const slug = workspaceSlugOfPath(pathname);
  const current = workspaces.find((entry) => entry.slug === slug);

  if (workspaces.length === 0 && !canCreate && pendingInvitations === 0)
    return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex min-h-11 min-w-11 cursor-pointer items-center gap-2 rounded-full border-0 bg-transparent px-2 py-1 text-foreground transition-all hover:bg-surface sm:px-3"
        >
          <span className="flex min-w-0 flex-col items-start leading-4">
            <span className="sr-only text-xs font-normal text-muted-foreground sm:not-sr-only">
              Workspace
            </span>
            <span className="max-w-28 truncate text-sm font-semibold sm:max-w-40">
              {current?.name ?? "Switch"}
            </span>
          </span>
          <CaretDownIcon aria-hidden="true" className="size-4 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuGroup aria-label="Your workspaces">
          {workspaces.map((entry) => (
            <DropdownMenuItem key={entry.slug} asChild>
              <Link
                href={workspaceHome(entry.slug)}
                aria-current={entry.slug === slug ? "true" : undefined}
                className="text-foreground no-underline"
              >
                {entry.name}
              </Link>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        {pendingInvitations > 0 || canCreate ? <DropdownMenuSeparator /> : null}
        {pendingInvitations > 0 ? (
          <DropdownMenuItem asChild>
            <Link href="/invitations" className="text-foreground no-underline">
              Invitations ({pendingInvitations})
            </Link>
          </DropdownMenuItem>
        ) : null}
        {canCreate ? (
          <DropdownMenuItem asChild>
            <Link
              href="/workspaces/new"
              className="text-foreground no-underline"
            >
              Create a workspace
            </Link>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
