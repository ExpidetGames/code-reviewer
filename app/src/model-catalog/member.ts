// SPDX-License-Identifier: LicenseRef-Proprietary

// What a member of a workspace sees of a catalog entry (#425, ADR 0005, 2.6): the name the operator chose and what it
// serves, never the provider or the model id. The type has no such member and `toMemberEntry` copies the listed fields
// one by one, so an entry that carries more cannot leak it by being passed along (`entries.test.ts` pins both).
import type { ProjectReviewKind } from "../review-settings/settings.ts";
import type { CatalogStatus } from "./entries.ts";

export type MemberCatalogEntry = {
  id: string;
  name: string;
  description: string | null;
  kinds: readonly ProjectReviewKind[];
  status: CatalogStatus;
  sortOrder: number;
};

export function toMemberEntry(entry: MemberCatalogEntry): MemberCatalogEntry {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    kinds: [...entry.kinds],
    status: entry.status,
    sortOrder: entry.sortOrder,
  };
}
