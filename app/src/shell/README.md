# App frame

The frame around every signed in page, and the three places inside it. Colors, buttons and the
other small building blocks are in `src/ui/` and `src/app/globals.css`; the color mode is in
`src/theme/`.

| File              | Role                                                                                                                                                                                                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nav-items.ts`    | The three places (Projects, Runs, Settings) and `isCurrentPage` (a place is current on its own path and below it). One list feeds links and active state.                                                                                                                                                  |
| `nav-links.tsx`   | The navigation links. `NavLinks` takes the path as a value, `CurrentNavLinks` reads it from the router.                                                                                                                                                                                                    |
| `app-shell.tsx`   | Skip link, header (brand, navigation, user menu slot) and the `main` landmark. On a narrow screen the navigation sits behind the "Menu" button (`aria-expanded`), closes after a choice, on any page change (brand link, back and forward), on a press outside it (also on the user menu) and with Escape. |
| `user-menu.tsx`   | The button with avatar and name that opens a panel: name and login, the theme choice, "Sign out" (disabled while it runs). A disclosure, so it works with Tab and Enter; Escape, a click outside and moving the focus away close it.                                                                       |
| `user-avatar.tsx` | The GitHub avatar (https only, no referrer) or the initials; never a broken image.                                                                                                                                                                                                                         |
| `user-display.ts` | Display name (the login when the profile has no name), initials, `safeAvatarUrl`.                                                                                                                                                                                                                          |

The pages live in `src/app/(app)/` (route group, no effect on the URLs): `layout.tsx` wraps them in
`AppShell`, `runs` is a placeholder with an empty state until its ticket fills it; `projects` (the list and, below
it, `[repositoryId]` for the settings of one project) and `settings` are real pages, see
`src/projects/README.md` and `src/review-settings/README.md`. `/` redirects to `/projects`. Without JavaScript the narrow Menu button does nothing (the navigation stays folded); the rest keeps working. The login page is outside the frame.

## Rules

- A new signed in page goes below `src/app/(app)/`, calls `requireUser()` itself (the second guard
  behind the proxy, see `src/auth/README.md`) and renders a `PageHeader` with the page's one `h1`.
  A new place in the navigation is one more entry in `nav-items.ts`.
- With Cache Components the frame is static. The user menu needs the session, so the layout renders
  it behind `<Suspense>`; the page children are behind `<Suspense>` too (they read the session). Do not
  read `cookies()` or `headers()` in the shell components themselves.
- The user menu gets only what it shows (`ShellUser`), never the whole session user. Name and avatar
  come from the GitHub profile and are untrusted: they are rendered as text, and the avatar only when
  it is an https address.
- Breakpoint: below 48rem the navigation folds into the Menu button (`globals.css`). Keep the
  navigation reachable by keyboard in both layouts: a closed narrow navigation is `display: none`.

## Tests

- `app-shell.test.tsx`, `user-menu.test.tsx`: component tests (jsdom, Testing Library) for the
  navigation, the narrow menu and the user menu, including a hostile name and a missing avatar.
- `app-pages.integration.test.ts`: the proxy and the pages turn away a visitor without a session,
  and the sign out action ends the session on the server.
- `e2e/app/navigation.e2e.ts`: the three places and sign out on a desktop window, the menu on a
  375 px window.
- Not automated: how it looks (contrast in both modes, nothing cut off, no flash of the wrong mode on
  load). That is a visual check by a team member before a release.
