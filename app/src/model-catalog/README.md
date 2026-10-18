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
for words a member must not read; the copy of the model choice and the description of an entry are held to the same
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

- **Release asks the provider's metadata** (`src/llm/model-capabilities.ts`), like the tiers did (#280): a Dynamic entry
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

The claim and `resolveModelSelection`, and the `modelAccess` entitlement (the admin portal is
#429, above). There is no operator API for the catalog (decision C8). The selection settings of a project (the entry per
kind, the picker) are in `src/review-settings/README.md`.

## Migrated from the tiers (#434)

Before the catalog a workspace on the operator's key chose a quality tier, Low, Medium or High (#280, #283), and the
operator said which model backed each tier and kind (the instance setting `managed_model_tiers`, written through
`PUT /api/operator/v1/model-tiers`). The tiers are removed in the same series as the catalog (ADR 0005, decision C1); the
migration `20261018160000_migrate_model_tiers_to_catalog.ts` (its pure part is `db/migrations/model-tiers-to-catalog.ts`)
moves the data over so that no managed workspace changes model:

- **Entries.** For each tier and kind with a model there is a `released` entry of the default provider. A tier whose Diff
  and Dynamic model are the same id becomes one entry that serves both kinds, named `Low`, `Medium` or `High`; otherwise
  there are the entries `<Tier> (Diff)` and `<Tier> (Dynamic)` (a tier with one kind has only that one). The description is
  the sentence the quality level had (speed and depth, no model, vendor or price). The order is Low, Medium, High. The
  ids are a function of the slug (`mce_` plus a digest), so a second run finds its entries; a name an operator already
  uses gets "(migrated)" appended, so the migration never fails on the unique name.
- **Defaults.** `catalog_defaults` gets the Medium entries for each kind that has no default yet (the tier a project
  without a choice had); a default the operator set stays.
- **Selections.** A project's own `modelTier` (the default tier included) becomes `catalogEntryDiff` and
  `catalogEntryDynamic`; a workspace-level `modelTier` is written into the projects that inherit it, where it differs from
  the default tier (there is no workspace-level entry). A selection that is already set stays. A kind the tier has no entry
  for gets none, so the instance default of that kind applies, as it does to any project without a choice. Damaged JSON
  is skipped and named by id in the log, never by content.
- **Safe to run.** It only adds. It is idempotent, needs no `APP_SECRET`, decrypts nothing, uses the same SQL on SQLite
  and Postgres and does nothing when `managed_model_tiers` is missing, empty or holds no readable model (a self-hosted
  instance on its own key never had one). The projects are read in one query and written in chunks of 500 with one
  `UPDATE … FROM (VALUES …)` each, so the time does not grow with a statement per project (about 0.2 s for 5,000 and 0.8 s
  for 20,000 projects on a local Postgres, instead of 2.2 s and 10.3 s). A row is written only if it still holds the text
  that was read (a settings save that lands between the read and the write is never overwritten) and a row that changed
  is read again, three times at most. A differential test
  (`integration-tests/http/model-tiers-migration-claim.integration.test.ts`) hands the same (tier, kind) to the new claim
  and compares the model with the old rule.
- **What differs from the tiers, on purpose.** (1) A tier that had no model for a review kind used to end that kind's job
  with `managed_tier_unavailable` (fail closed). The migration makes no entry for it, so a project on that tier gets no
  selection for the kind and runs it on the instance default entry (the Medium one), the same as a project that chose
  nothing. The differential test pins this (`tiers that lack a kind`). (2) A workspace-level tier is written into the
  projects that exist at the migration, because there is no workspace-level entry; a repository activated later starts
  with settings `{}` and gets the instance default entry, not its workspace's old Low or High. The operator chooses an
  entry for it in the project's settings, or changes the default. (3) A project of a workspace on its own key is rewritten
  like any other (the workspace may turn managed later), but its entries are inert while the key is the workspace's own: an
  own job reads no catalog and no entry (`src/llm/selection.ts`); the claim of such a workspace is the same before and
  after (`model-tiers-migration-claim.integration.test.ts`, T06).
- **After the release: the plans' `modelAccess`.** The migrated entries are new, so a `modelAccess` list that was set
  before (an explicit list, `[]` included) does not contain them. For such a workspace both the entry of a project that had
  a tier and the default entry are outside the list, and every job ends with `managed_model_unavailable` (the claim fails
  closed, as #428 intends; a list that is absent allows every released entry). The operator adds the migrated entries to
  every plan's list, the Free plan included once billing is on (it is created with `[]`), and to every list set by hand.
  Tests pin both the stop and the way out (`model-tiers-migration-claim.integration.test.ts`, X5).
- **The old data stays.** `managed_model_tiers`, the `modelTier` members of the stored settings and the column
  `usage_records.model_tier` are read by nothing (the usage feed and the Runs view still show a run that was written under a
  tier). A later forward-only migration, one release after, deletes them (`docs/deployment-vercel.md`, 5.6). A save of
  the settings of a project drops its `modelTier` with the Diff group, which is why the migration copies its meaning first.
- **Rollback is not safe.** The app of the previous release still finds the old data, so it runs the tiers as before; no
  migration is undone (Kysely migrations are forward only). Projects whose settings were saved on the new release lost their
  `modelTier` and run on the default tier on the old release; entries the migration made stay in the catalog and are
  harmless there. #432, #433 and #434 go back together, and a fix forward is the normal way out. A settings page opened
  before the release can send the old quality level once: the save is refused with `UNKNOWN_FIELD` and a reload fixes it.

## The token budget of a managed job

The workspace's `maxTokens` stays the workspace's and is cut down to the context window of the entry's model when the
provider's metadata states one (`token-budget.ts`, `clampMaxTokens`; the same read serves the capabilities of a Dynamic
job). When a fresh read fails, the window last read for that model (kept a day) is used; when none was ever read, the
budget is cut to `UNKNOWN_WINDOW_MAX_TOKENS` (100,000, the built-in budget): a managed job's budget is never sent
unclamped, whatever the workspace saved (up to two million). The instance's `LLM_MAX_TOKENS` belongs to the instance's
own model and is not used for a managed job. The claim asks as a claim: an answer that is not `supported` is remembered
45 seconds (`src/llm/README.md`).

## The model never leaves the server

The model id of an entry goes to the instance admin portal and to the runner (it needs it to call the provider), nowhere
else. Not in the stored settings of any workspace, not in a settings answer or page, not in a plan or usage view, not in the
usage record, which names the entry and its name at the claim. **Not in the result of a run:** for a job on the operator's
key `usage.model` is `null` and the ids of every entry, whatever its status, become `[model]` in any text (the place that
masks credentials, `runner-api/report.ts`, `managedModelsOf` in `runner-api/managed-models.ts`), together with the model the
job was handed (remembered with its keys, `runner-api/claimed-keys.ts`). The Runs view shows no cost for such a run. The
runner pins `output_run_details` and `output_relevant_configurations` to `false`, so a published comment names no model.
Logs name the entry id and the kind, never the model. `integration-tests/http/model-catalog-privacy.integration.test.ts`
searches every answer a member can read for the ids of the entries.
