// SPDX-License-Identifier: Apache-2.0

"use client";
// The workspace switcher in the header: the workspace the page is in (read from the address), and a panel
// with the workspaces the signed in person belongs to, each a plain link to that workspace. A person who may
// create workspaces (a multi-tenant instance) finds the link here too, and so do the invitations waiting for
// them. It is a disclosure like the user menu: Escape, a click outside and moving the focus away close it.
// Only names and slugs of workspaces the person is a member of are ever passed in.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { workspaceHome, workspaceSlugOfPath } from "../paths.ts";

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
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  if (workspaces.length === 0 && !canCreate && pendingInvitations === 0)
    return null;

  return (
    <div
      ref={rootRef}
      className="workspace-switcher"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
      }}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (open && next instanceof Node && !rootRef.current?.contains(next))
          setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className="workspace-switcher-button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="muted small">Workspace</span>
        <span className="workspace-switcher-name">
          {current?.name ?? "Switch"}
        </span>
      </button>
      {open ? (
        <div id={panelId} className="workspace-switcher-panel">
          <ul className="nav-list workspace-list" aria-label="Your workspaces">
            {workspaces.map((entry) => (
              <li key={entry.slug}>
                <Link
                  href={workspaceHome(entry.slug)}
                  className="nav-link"
                  aria-current={entry.slug === slug ? "true" : undefined}
                  onClick={() => setOpen(false)}
                >
                  {entry.name}
                </Link>
              </li>
            ))}
          </ul>
          {pendingInvitations > 0 ? (
            <Link
              href="/invitations"
              className="nav-link"
              onClick={() => setOpen(false)}
            >
              Invitations ({pendingInvitations})
            </Link>
          ) : null}
          {canCreate ? (
            <Link
              href="/workspaces/new"
              className="nav-link"
              onClick={() => setOpen(false)}
            >
              Create a workspace
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
