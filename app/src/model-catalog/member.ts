// SPDX-License-Identifier: LicenseRef-Proprietary

// What a member of a workspace sees of a catalog entry (#425, ADR 0005, 2.6): the name the operator chose, what it serves
// and, since #675, the name of the model provider (`providerLabel`), never the provider id or the model id. The
// type has no such member and `toMemberEntry` copies the listed fields one by one, so an entry that carries more cannot leak
// it by being passed along (`entries.test.ts` pins both).
import type { ProjectReviewKind } from "../job-kind/job-kind.ts";
import type { CatalogStatus } from "./entries.ts";

export type MemberCatalogEntry = {
  id: string;
  name: string;
  description: string | null;
  /** The maker of the model as people know it (`provider-label.ts`); the pickers show it as the provider. */
  providerLabel: string;
  kinds: readonly ProjectReviewKind[];
  status: CatalogStatus;
  sortOrder: number;
};

export function toMemberEntry(entry: MemberCatalogEntry): MemberCatalogEntry {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    providerLabel: entry.providerLabel,
    kinds: [...entry.kinds],
    status: entry.status,
    sortOrder: entry.sortOrder,
  };
}
