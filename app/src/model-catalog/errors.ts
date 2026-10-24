// SPDX-License-Identifier: LicenseRef-Proprietary

// The stable codes the model catalog answers with when a change is refused (#425). The admin portal translates them to
// copy; nothing branches on a message. Names that ADR 0005 (2.8) fixed keep their spelling, the rest follows the
// codes of the entitlements (lower case). The last five are the checks of a model against the provider's metadata and
// are spelled as the review settings and the managed tiers spell them.
export const CATALOG_ERROR_CODES = [
  /** Not the documented shape (not an object, a field of the wrong type, a sort order that is no integer). */
  "request_invalid",
  /** 1 to 40 printable characters, no space at either end. */
  "name_invalid",
  /** The name contains the entry's model id, its slug or its provider. */
  "name_reveals_model",
  /** Another entry has this name, whatever the case. */
  "catalog_name_taken",
  /** Too long, on several lines, or it speaks of a model, a vendor, a price or a cost. */
  "description_invalid",
  /** The provider is not one of the registry. */
  "PROVIDER_UNKNOWN",
  /** A model id the review settings would refuse too. */
  "model_id_invalid",
  /** No kind, or a kind that is not Diff or Dynamic. */
  "kinds_invalid",
  "CATALOG_ENTRY_UNKNOWN",
  /** A default names an entry that is not released. */
  "CATALOG_ENTRY_NOT_RELEASED",
  /** A default names an entry that does not serve the kind. */
  "CATALOG_ENTRY_KIND_MISMATCH",
  /** The status cannot move that way (draft to released, released to retired, retired to released). */
  "catalog_transition_invalid",
  /** Only a draft is deleted. */
  "catalog_entry_not_draft",
  /** The entry is the instance default of a kind and would stop being fit for it. */
  "catalog_entry_is_default",
  /** Somebody changed the entry while this change was checked; nothing was written, read it again. */
  "catalog_conflict",
  "MODEL_UNKNOWN",
  "DYNAMIC_MODEL_TOOLS_UNSUPPORTED",
  "DYNAMIC_MODEL_UNKNOWN",
  "DYNAMIC_MODEL_UNVERIFIED",
] as const;
export type CatalogErrorCode = (typeof CATALOG_ERROR_CODES)[number];
