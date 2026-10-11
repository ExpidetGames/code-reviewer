# Workspaces

A workspace owns the customer data of an installation: connections (`integrations`), repositories,
projects, jobs and the review defaults. A user reaches a workspace as a member with a role (`owner`,
`admin`, `member`, `roles.ts`). The decision is in `docs/decisions/0001-editions-setup-and-accounts.md`
(sections 2.6 and 2.7); the tables and the migration are described in `src/db/README.md`.

This folder holds the first step only: the data model and the scoping. Roles beyond storing them,
members, invitations, the switcher and any UI come with the workspaces feature.

| File                      | Role                                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `roles.ts`                | `WORKSPACE_ROLES`, the three roles (the database restricts the column to the same list)                                       |
| `current-workspace.ts`    | **Temporary.** `resolveCurrentWorkspaceId` / `getCurrentWorkspaceId`: the workspace a signed-in user works in                 |
| `in-current-workspace.ts` | `inCurrentWorkspace(build)`: a service for the current workspace that looks it up on its first call, not when it is asked for |

## How the code is scoped

- **Repositories** are created for one workspace (`createXRepository(db, workspaceId, ...)`) and every
  query filters by it; a workspace never sees a row of another (`src/db/README.md`, "Workspace
  scoping"). A test enforces the signature, another one the behaviour.
- **Services and wiring** (`shared.ts` of each module) offer `xxxFor(workspaceId)` for code that knows
  the workspace (the webhook handler, the runner API) and `getXxx()` for a signed-in request, which
  works in the current workspace.
- **Webhooks** find the integration by the installation id (in any workspace,
  `integration-directory-repository.ts`) and then work in the workspace that integration names.
- **The runner API** serves the whole instance: the queue's lease side is not scoped, and everything a
  claim looks up for a job (repository, connection, project, settings) is looked up in `job.workspaceId`.
- **The synchronization** walks every connection of the instance through the same directory and changes
  each one in its own workspace. A connection that is new to the instance goes to the default workspace
  (temporary, see below).

## The current workspace (temporary)

Until workspace switching exists, every signed-in user works in **the default workspace**: the oldest
workspace, which the migration made for an installation that had data. **A database that has no
workspace yet (a fresh installation) gets one the first time something needs it**
(`WorkspacesRepository.ensureDefault`, safe against two requests at once), so that today's flow
(sign in, sync from GitHub, activate a repository) keeps working until the first-run setup creates the
workspace itself. Who may sign in is still decided by the existing access policy, so nobody gains
access. The workspaces feature replaces `resolveCurrentWorkspaceId` with the lookup of the user's
membership and removes `ensureDefault` from the request path; nothing else has to change, because
everything below already asks for a workspace id.
