# Plan handoff

Hands an Owner or Admin of a workspace over to **an operator-configured page**, as an identified member of that
workspace (issue #284, part of #268). An operator who manages plans in an external service gets, with the click, the
workspace, the person's role and an opaque user id, without a second account and without a shared signing secret.
The app does nothing else: no payment, no price, no plan catalog, no session on the other side.

Off by default. While no page is configured there is no button and **the route does not exist** (the answer of a path
that does not exist), so an instance that never sets it has no new surface.

## The setting

`plan_management_url` (instance setting): an absolute **`https:`** address, no user name or password, no `#fragment`,
at most 2048 characters, no white space (`url.ts`, `checkPlanManagementUrl`). It is stored in its normal form and
checked again when it is read: a stored value that fails the check reads as unset (fail closed). Two places write it,
both through `savePlanManagementUrl` (`settings.ts`):

- the instance admin, in the admin portal under **Instance** (`PUT /api/admin/settings`
  `{ "planManagementUrl": "https://…" | null }`, `src/admin/`);
- the operator API: `GET|PUT|DELETE /api/operator/v1/plan-management` (`src/operator-api/README.md`).

Anyone who can write it can send workspace Owners and Admins to that page: it is as trusted as the operator token.
**Upgrade every app instance before you set it** (see "Mixed versions").

## The button and the route

An Owner or Admin sees **Manage plan** in the workspace settings (General, card "Plan") while a page is configured
(`ui/manage-plan-card.tsx`; a Member does not see it). It is a plain `<form method="post">` to
`POST /api/w/<slug>/plan-handoff` (`http.ts`, order of the checks):

1. **configured**: no usable page, a missing path (Next's `notFound()`), before the session is looked at;
2. **same site**: `Sec-Fetch-Site` / `Origin` (`src/http/request-checks.ts`), else the browser is sent back to the settings page of the workspace with `plan_error=cross_site_request` (below);
3. **access**: the session and the role, `manage_plan` (Admin and Owner), else the refusals of every workspace route
   (`401`, `404` for another workspace, `403 forbidden` for a Member) and no token is made;
4. **limit**: 10 clicks per person and workspace in 10 minutes, in the shared `rate_limits` table (`limits.ts`), else
   else the same, with `plan_error=rate_limited`;
5. **token**: made and stored, and the browser gets `303` to the page with `?handoff=<token>`.

The body and the query of the request are never read, so **the target is the setting and nothing of the request**:
there is no open redirect. The answer is `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. The log gets one
line `[plan-handoff] workspace=<id> result=ok|rate_limited` (an id and a code; never a token, a person or an address).

## The handoff token

256 random bits (43 base64url characters, `token.ts`). The database keeps only its **SHA-256 hash**
(`plan_handoff_tokens`, `src/db/README.md`), bound to the workspace, the person and the role they have at the moment of
the click, valid for **5 minutes** and **single use**. A new token of the same person in the same workspace revokes the
unused older ones (one transaction, `plan-handoff-tokens-repository.ts`; on Postgres the transaction first locks the person's membership row, so two clicks at the same time still leave exactly one live token). It is not signed: it is an unguessable
reference that only a database row gives meaning to, which is what makes revocation and the single use exact on every
app instance.

## Redeeming it

The external service calls `POST /api/operator/v1/handoff/redeem` `{ "token": "…" }` with the operator token and
learns `{ workspaceId, workspaceSlug, userId, role }` (`src/operator-api/README.md`, contract
`HandoffRedeemResponse`):

- the token is used up by one guarded statement (`update … where used_at is null and revoked_at is null and expires_at > now`),
  so of two redemptions exactly one answers, on every instance;
- **the role is checked again**: if the person is no longer a member with the role the token was made for (demoted,
  promoted, removed), the answer is `invalid_token` and the token is used up;
- an unknown, used, expired or revoked token, a token of another shape and a lost role all get **one answer**,
  `422 invalid_token`, so nothing says which it was;
- the answer holds ids, the slug and the role: no email, no name, no repository. `userId` is opaque to the service
  (the stable internal id of the person, nothing to look anything up with).

The service should redeem the token **before it renders anything**, and not keep it in its address bar, its logs or the
links of its pages (it is one-shot and expires, but it is a credential for five minutes). The app cannot control that
side.

## Coming back

The service sends people back to the path of `planReturnPath` (`return-path.ts`): **`/w/<slug>/settings/plan`** of this
app, the plan and usage page of the workspace (#282, `src/usage/README.md`, "The plan page"), which every member can open.
The path is fixed here and nothing in a request chooses it, so the app has no return redirect to abuse. The one constant
`PLAN_RETURN_PATH_SECTION` (`/plan`) decides it, for the refusal notice link and, with the description in the contract,
for the operator's page; tests keep the constant, the settings navigation's address and the contract in agreement.

"Manage plan" is on **both** the General settings page and the plan page, for an Owner or Admin while a page is
configured. General keeps it because a workspace without entitlements has no plan page link in the navigation (it has
nothing to show) and is still where an operator may want to send an owner to start a plan; the plan page has it
because that is where people arrive from a refusal notice and from the operator's page. A refused click from either
page comes back to General (below).

## A refused click

The button is a plain form post, so the browser shows what the route answers. A refusal that a person can cause by
clicking (`cross_site_request`, `rate_limited`) therefore answers `303` back to `/w/<slug>/settings?plan_error=<code>`
with an empty body (`errors.ts`; the slug is encoded into one path segment, so the target is always a path of this app).
The page reads the code against the closed list, shows the sentence next to the button and shows nothing for any other
value. A Member (who has no button), a lost session and a workspace that is not the person's keep the usual JSON answers
of every workspace route.

## The refusal notice

A refused review's comment on the pull request (`src/refusal-notices/`) links to that same plan page of the workspace
(`planReturnPath` on this app, never the operator's page) exactly while a page is configured
(`src/refusal-notices/plan-link.ts`).

## Mixed versions

New table (empty, no existing row touched, never read by the previous release), a new instance setting key (ignored by
the previous release), new routes and definitions in the operator contract. An app instance of the previous release
neither shows the button nor knows the table, and answers `/api/operator/v1/handoff/redeem` with its generic
`404 not_found`. So **upgrade every app instance first, then set the page**: a token made by a new instance and
redeemed at an old one would otherwise be answered `not_found` and not used up. Apps and runners can be deployed in any
order; no runner is involved.

## Files

| File                      | Role                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------- |
| `url.ts`                  | `checkPlanManagementUrl` (the rules), `handoffLocation` (the redirect address)          |
| `settings.ts`             | `readPlanManagementUrl` (fails closed), `savePlanManagementUrl` (what both writers use) |
| `token.ts`                | The token: made, hashed, checked for its shape                                          |
| `limits.ts`               | The per-person, per-workspace limit on clicks                                           |
| `http.ts`                 | The handler of `POST /api/w/:workspace/plan-handoff` as a function of its collaborators |
| `shared.ts`               | The wiring on the running server (the route file and the settings page call it)         |
| `ui/manage-plan-card.tsx` | The "Manage plan" card                                                                  |
