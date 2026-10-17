# Model catalog

The operator's list of the models that workspaces on the operator's key may use (#425, part of epic #420;
docs/decisions/0005-providers-model-catalog-and-paddle-billing.md, 2.6). An entry has a free **name** that members see
and a provider and a real model id that **only the operator** sees. This folder is the data and the rules; nothing
shows the catalog yet (the admin portal, the selection settings, the claim and the `modelAccess` entitlement come with
later issues of the epic). **The catalog is empty by default, and an empty catalog changes nothing** for any workspace:
nothing reads it on a claim, and no self-hoster has to do anything.

| File         | Role                                                                                                                                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entries.ts` | Pure: the statuses and the move between them, the kinds, `CatalogEntry`, `CatalogDefaults`, the checks of a name (`checkEntryName`, `nameKeyOf`, `nameRevealsModel`) and a description |
| `member.ts`  | `MemberCatalogEntry`, the typed view of an entry for a member (no provider, no model id), and `toMemberEntry`                                                                          |
| `errors.ts`  | `CATALOG_ERROR_CODES`, the stable codes of a refused change                                                                                                                            |
| `service.ts` | `createCatalogService`: create, update, release, retire, remove, `usedByProjects`, the defaults, the member view and `allCatalogModelIds`                                              |

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
  entry's model id, the part of it after the last `/` or the provider (`name_reveals_model`, in any case; checked again
  when the model changes). A name like "Opus" that hints at a vendor family is the operator's choice.
- **Description:** optional, one line of at most 160 characters, scanned for model, vendor, price and cost words
  (`description_invalid`).
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
  fields #430 will write), of any workspace, and returns a number only.
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

## Not here

The admin portal, the claim and `resolveModelSelection`, the selection settings of a project, the `modelAccess`
entitlement and the migration of the old tiers (`src/model-tiers/`, which stays untouched). There is no operator API for
the catalog (decision C8).
