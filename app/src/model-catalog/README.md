# Model catalog

The operator's list of the models that workspaces on the operator's key may use (#425, part of epic #420;
docs/decisions/0005-providers-model-catalog-and-paddle-billing.md, 2.6). An entry has a free **name** that members see
and a provider and a real model id that **only the operator** sees. This folder is the data and the rules, and the
operator's side of them in the admin portal (#429, below). **The catalog is empty by default, and an empty catalog changes
nothing** for any workspace, and no self-hoster has to do anything: the section in the admin portal is collapsed while it
is empty.

| File                                                                                 | Role                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entries.ts`                                                                         | Pure: the statuses and the move between them, the kinds, `CatalogEntry`, `CatalogDefaults`, the checks of a name (`checkEntryName`, `nameKeyOf`, `nameRevealsModel`) and a description  |
| `member.ts`                                                                          | `MemberCatalogEntry`, the typed view of an entry for a member (no provider, no model id), and `toMemberEntry`                                                                           |
| `errors.ts`                                                                          | `CATALOG_ERROR_CODES`, the stable codes of a refused change                                                                                                                             |
| `service.ts`                                                                         | `createCatalogService`: create, update, release, retire, remove, `usedByProjects`, the defaults, `checkModel`, `summary`, the member view and `allCatalogModelIds`                      |
| `admin-service.ts`, `admin-view.ts`, `admin-errors.ts`, `admin-http.ts`, `shared.ts` | The admin portal's side (#429): the view with the number of projects per entry, the confirmation before a change of model, the route handlers, their codes and statuses, and the wiring |

The table is `model_catalog_entries` (migration `20261017140000_create_model_catalog_entries`, `src/db/README.md`), its
repository is the instance level `src/db/repositories/catalog-repository.ts`. `../copy/member-copy-scan.ts` is the scan
for words a member must not read; the copy of the quality levels and the description of an entry are held to the same
patterns.

## An entry

`id` (`mce_` and 32 random hex digits: opaque, never reused, the only thing that leaves the server), `name`,
`description`, `provider`, `modelId`, the kinds it serves (Diff, Dynamic or both; at least one, also a check of the
table), `status`, `sortOrder`, who changed it last and when.

- **Name:** 1 to 40 printable characters, no space at either end, **unique whatever the case** (decision C3; refused
  `catalog_name_taken`). The uniqueness is a unique index on the stored `name_key` (the name folded to lower case), so it
  is the same on SQLite and Postgres. The name is shown to members by design, so it is refused when it contains the
  entry's model id, its slug (the part after the last `/`, with or without a `:variant` such as `:free`) or the provider.
  The comparison folds the text first (compatibility forms, lower case, letters and digits only), so "Claude Sonnet 5.5",
  "claude_sonnet_5_5" and a fullwidth spelling are caught like the id itself; a piece shorter than four letters and
  digits is not compared (`name_reveals_model`; checked again when the model changes). A name like "Opus" that hints at a
  vendor family is the operator's choice.
- **Description:** optional, one line of at most 160 characters, scanned for model, vendor, price and cost words, and
  held to the entry's own model: the same comparison as the name, plus the vendor prefix of the id ("xAI", "x-ai", "X AI")
  and the words of the slug that name a family or version ("Grok", "qwen3"), as whole words
  (`descriptionRevealsModel`; `description_invalid`, checked again when the model changes). **Not covered:** a brand that
  the id does not contain, and the descriptive words of a slug ("fast", "coder", `DESCRIPTIVE_WORDS`), which an operator
  may use. The scan of the copy knows the common brand names; nothing can know all of them.
- **Provider:** one of `LLM_PROVIDERS` (`PROVIDER_UNKNOWN` otherwise). **Model id:** the rule of the review settings
  (`model_id_invalid`).

## Status

`draft` (being prepared) to `released` (may be chosen) to `retired` (stays for what already uses it) and back to
`released`. Nothing returns to draft and a draft is never retired (`catalog_transition_invalid`).

- **Release asks the provider's metadata** (`src/llm/model-capabilities.ts`), like the managed tiers do: a Dynamic entry
  must be `supported` (`DYNAMIC_MODEL_TOOLS_UNSUPPORTED`, `DYNAMIC_MODEL_UNKNOWN`, `DYNAMIC_MODEL_UNVERIFIED`); a Diff
  entry is refused only when the provider does not know the model (`MODEL_UNKNOWN`), an `unverifiable` one is accepted.
  An entry that serves both is held to the stricter rule. Nothing is written on a refusal. Today there is one provider;
  the check will follow the adapter registry of #423.
- **A released entry is never hard-deleted** (its id stays in the mask list and in old usage records); a `draft` may be
  (`remove`; `catalog_entry_not_draft` otherwise, and the statement itself only deletes a draft).
- **Changing the model or the provider behind a released entry** (C6) is allowed after the same check, writes an audit
  line to the log (the entry, the person, the model before and after, how many projects use it) and returns
  `modelChange: { projects }`. `usedByProjects(id)` gives the same number beforehand, for the confirmation of the
  portal. It counts the projects whose settings select the entry (`catalogEntryDiff` or `catalogEntryDynamic`, the
  fields of the review settings, #430), of any workspace, and returns a number only.
- Every write is guarded by what the check saw (`updated_at`, and the status for a move): a change that lost a race
  writes nothing and is refused `catalog_conflict`.

## The instance defaults

Instance setting `catalog_defaults` (`{ "diff": "<entry id>" | null, "dynamic": "<entry id>" | null }`, no row: none).
`setDefaults` refuses an entry that does not exist (`CATALOG_ENTRY_UNKNOWN`), is not released
(`CATALOG_ENTRY_NOT_RELEASED`) or does not serve the kind (`CATALOG_ENTRY_KIND_MISMATCH`), and stores nothing. The entry
that is a default cannot be retired or stop serving the kind (`catalog_entry_is_default`). `defaults()` checks the
stored value again against the entries: one that is no longer fit reads as none, so a managed job would fail closed
instead of using an entry that cannot serve. There is no workspace level default.

## What a member sees

`MemberCatalogEntry` is `id`, `name`, `description`, `kinds`, `status`, `sortOrder` and has no `provider` or `modelId`.
`memberEntries()` lists the released and the retired entries (a project may still have a retired one chosen; a draft is
never shown), and the repository selects only those columns, so the provider and the model id are not even read.
`allCatalogModelIds()` gives the model id of every entry of every status: with the models of a job, the ids to mask in
anything a member reads.

## The admin portal (#429)

The catalog is managed in a section of the LLM page of the admin portal (`/admin/llm`, `src/admin/ui/catalog-section.tsx`):
empty and collapsed ("Only needed for workspaces whose key mode is managed"), so an instance on its own keys has nothing
new to do. The table lists every entry, a retired one too, with the provider and the model id, the kinds, the status and
"used by N projects"; the dialog adds or edits an entry (the name carries the warning that members see it) and has a
**Check model** button, which asks the provider's metadata what release asks and stores nothing. Actions: release (draft or
retired), retire (after a confirmation with the number of projects that use the entry), delete (a draft), move up or
down, and the default of each kind. The overview shows counts per kind and whether the kind has a default, never a name
or a model (`summary()`).

Routes (`/api/admin/model-catalog`, files in `src/app/api/instance-portal/model-catalog/`, handlers in `admin-http.ts`):

| Route                                   | Does                                                                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`                                 | The view: every entry (with `usedByProjects`), the two defaults, the providers                                                            |
| `POST /`                                | A new entry, as a draft                                                                                                                   |
| `PUT /:id`                              | Changes the given fields; the model or provider behind a released entry needs `"confirmModelChange": true`                                |
| `DELETE /:id`                           | Deletes a draft                                                                                                                           |
| `POST /:id/release`, `POST /:id/retire` | The status moves (release re-runs the check)                                                                                              |
| `PUT /defaults`                         | `{ diff, dynamic }`, each an entry id or null                                                                                             |
| `PUT /order`                            | `{ order: [id, ...] }`, every entry once, first to last, in one transaction (`catalog_conflict` when the list is not exactly the entries) |
| `POST /check`                           | `{ provider, modelId, kinds }` answers `{ ok: true, verified }` or `{ ok: false, error }` (the provider's word)                           |

The admin first (401 for nobody, the 404 of a missing path for anyone else), then for a change the request's origin
(`cross_site_request`), `application/json` and a body of at most 64 KB, then the service. Every refusal is
`{ error: <code>, issues?: [{ field, code }] }` with a code of `admin-errors.ts` and its status; the page turns the code
into copy (`src/admin/ui/catalog-messages.ts`), moves the focus to the first refused field and never shows a code. **A model
change behind a released entry** (decision C6) is answered `409 model_change_not_confirmed` with the number of `projects`
that use it, and nothing is written, until the request repeats it with `confirmModelChange: true` (the service decides on the entry it
writes, which the write is pinned to by `updatedAt`, so a release in between ends as `catalog_conflict` and cannot skip it; the
dialog asks only when the server says so and shows the server's count); the service then checks
the model again and writes the audit line (the entry, the account, the model before and after, the count) to the server
log, which is the operator's. Nothing here is reachable by a member of a workspace or by the operator API (decision C8).
"Used by" counts the projects whose settings select the entry and, for an instance default, the projects in a workspace
on the operator's key that chose no entry for the kind they run (Diff unless the project says Dynamic) and so fall back to
it. It is one pass over the projects for all entries (`countProjectsUsing`), computed once per answer.

**No "back to draft".** The issue lists it, but the status rules of #425 do not allow a return to draft (a released entry's
id is in old usage records and in the mask list), so the portal offers retire, which hides the entry from members and keeps
it listed here, and delete for a draft.

## Not here

The claim and `resolveModelSelection`, the `modelAccess` entitlement and the migration of the old tiers
(`src/model-tiers/`, which stays untouched; the overview no longer shows them). There is no operator API for
the catalog (decision C8). The selection settings of a project (the entry per kind, the picker) are in
`src/review-settings/README.md`.
