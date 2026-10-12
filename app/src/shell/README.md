# App frame

The frame around every signed in page, and the places of a workspace inside it. Colors, buttons and the
other small building blocks are in `src/components/` (shadcn kit) and `src/app/theme.css`; the color
mode is in `src/theme/`.

| File                     | Role                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nav-items.ts`           | The places of a workspace, in the two groups the sidebar shows (Projects, Runs — a separator — Connections, Members, Settings; #168 keeps Members a top-level item), built for the workspace the address names (`navGroupsFor`/`navItemsFor`; none outside a workspace), and `isCurrentPage` (a place is current on its own path and below it). One list feeds the links and the active state. |
| `nav-links.tsx`          | `NavLinks` renders the groups on the shadcn `Sidebar` (`SidebarGroup`, `SidebarMenu`, `SidebarMenuButton`, `aria-current="page"`); `CurrentWorkspaceSidebar` reads the path from the router and renders the `Sidebar` itself, or nothing outside a workspace so there is no empty column. The `Sidebar` is the Sheet drawer on a narrow screen; a link and a page change close it.             |
| `app-shell.tsx`          | The skip link, the header (the drawer trigger, the brand, the workspace switcher and the user menu) and the `SidebarInset` main landmark with the page. The header is sticky; the fixed sidebar starts below it (`SIDEBAR_TOP_CLASS`). The user menu and the switcher arrive as slots: they need the session, so the layout renders them on the server and the frame itself stays static.      |
| `workspace-switcher.tsx` | The DropdownMenu with the workspaces of the person, the waiting invitations and "Create a workspace" (multi-tenant only); moved here from `workspaces/ui/` with #168. Only names and slugs of workspaces the person is a member of are ever passed in.                                                                                                                                         |
| `user-menu.tsx`          | The DropdownMenu with name and login, `Account`, `Admin` (the instance admin only), the color theme (System, Light, Dark) and "Sign out". Radix handles the keyboard, Escape, the click outside and the focus return.                                                                                                                                                                          |
| `user-avatar.tsx`        | The GitHub avatar (https only, no referrer) or the initials; never a broken image.                                                                                                                                                                                                                                                                                                             |
| `user-display.ts`        | Display name (the login when the profile has no name), initials, `safeAvatarUrl`.                                                                                                                                                                                                                                                                                                              |

The pages live in `src/app/(app)/` (route group, no effect on the URLs): `layout.tsx` wraps them in
`AppShell`. The pages of a workspace are below `w/[workspace]/`: `projects` (the list and, below
it, `[repositoryId]` for the settings of one project), `runs` (the list and, below it, `[id]` for one
run), `settings` and `members` are real pages, see `src/projects/README.md`, `src/runs/README.md`,
`src/review-settings/README.md` and `src/workspaces/README.md`. `/projects`, `/runs` and `/settings` redirect
to the same page of the first workspace of the person (old bookmarks), `workspaces/new` and `invitations` are
the two places outside a workspace, and `/` redirects to the first workspace (or `/no-access`).

The admin portal (`/admin`, `src/admin/README.md`) renders behind its own layout and its own shadcn
`Sidebar` (`src/admin/ui/admin-nav.tsx`, grouped: Admin / Setup / Integrations), a static column
inside the admin frame next to the centered content — the fixed full-height sidebar of the workspace
is not used there, and the admin check runs before any section name is rendered. The pages of the app
that a configuration problem can block use the one "Needs attention" strip from
`src/config-status/notices.tsx` (`NeedsAttention`), next to `ConfigNotices` while those screens move
one by one (#169+).

## Rules

- A new signed in page goes below `src/app/(app)/`, calls `requireUser()` itself (the second guard
  behind the proxy, see `src/auth/README.md`) and renders a `PageHeader` with the page's one `h1`. A page
  of a workspace goes below `src/app/(app)/w/[workspace]/` and calls `requireWorkspace(slug)` instead
  (`guard-rule.test.ts` fails without it); its components get the slug as a prop and build every link and
  call with `workspacePath` / `workspaceApiPath`, and a client component keeps one API client per component
  (`useMemo`), not a new one per render. A new place in the navigation is one more entry in `nav-items.ts`.
- With Cache Components the frame is static. The workspace sidebar, the user menu and the workspace
  switcher need the request, so each sits behind its own `<Suspense>` boundary (the sidebar renders
  nothing meanwhile); the page children are behind `<Suspense>` too (they read the session). Do not
  read `cookies()` or `headers()` in the shell components themselves.
- The user menu gets only what it shows (`ShellUser`), never the whole session user. Name and avatar
  come from the GitHub profile and are untrusted: they are rendered as text, and the avatar only when
  it is an https address.
- Every color comes from a token in `src/app/theme.css` (`bg-card`, `text-muted-foreground`, ...), never
  a literal (the colour guard in `src/ci/colors` fails otherwise). Icon-only controls keep a 44px hit
  area and an accessible name; the skip link and `aria-current="page"` stay.

## Tests

- `app-shell.test.tsx`, `user-menu.test.tsx`, `workspace-switcher.test.tsx`: component tests (jsdom,
  Testing Library) for the sidebar groups, the current place, the menus (including a hostile name and
  a missing avatar) and the switcher.
- `app-pages.integration.test.ts`: the proxy and the pages turn away a visitor without a session,
  and the sign out action ends the session on the server.
- `e2e/app/navigation.e2e.ts`: the places and sign out on a desktop window, the drawer on a 375 px
  window.
- Not automated: how it looks (contrast in both modes, nothing cut off, no flash of the wrong mode on
  load). That is a visual check by a team member before a release.
