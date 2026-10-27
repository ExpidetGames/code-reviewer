// SPDX-License-Identifier: LicenseRef-Proprietary

// What the catalog routes of the admin portal send and the page shows (#429). The operator sees the provider and the
// model id of every entry; nothing here reaches a member (their view is `MemberCatalogEntry`, member.ts). Types only, so
// the page's client code can import this file.
import type { ProjectReviewKind } from "../job-kind/job-kind.ts";
import type { CatalogDefaults, CatalogStatus } from "./entries.ts";

export type AdminCatalogEntry = {
  id: string;
  name: string;
  description: string | null;
  provider: string;
  modelId: string;
  kinds: ProjectReviewKind[];
  status: CatalogStatus;
  sortOrder: number;
  /** ISO 8601 text in UTC. */
  updatedAt: string;
  /** How many projects, of any workspace, select the entry: a number and nothing else. */
  usedByProjects: number;
};

export type AdminCatalogProvider = { id: string; label: string };

export type AdminCatalogView = {
  /** Every entry of every status, by sort order and then by name: a retired entry stays listed. */
  entries: AdminCatalogEntry[];
  /** The instance default of each kind: the id of a released entry that serves it, or null. */
  defaults: CatalogDefaults;
  /** The providers an entry can name, in the order of the registry. */
  providers: AdminCatalogProvider[];
};
