// SPDX-License-Identifier: LicenseRef-Proprietary

// What the catalog stores (#548): the rows of the providers and models of models.dev as the app reads them, and the
// state of the last fetch. Types only. Client safe.
import type { ModelsDevFetchErrorCode } from "./errors.ts";
import type { ReducedModel } from "./parse.ts";
import type { UrlProblem, UrlRecord } from "./upstream-url.ts";

export type StoredProvider = {
  /** The id models.dev uses and the supported-provider file lists. */
  id: string;
  name: string;
  /** The trust on first use of the provider's address; the provider is usable only while `url.state` is `trusted`. */
  url: UrlRecord;
  /** When the block on a changed address began; null while there is none. */
  urlChangedAt: string | null;
  firstSeenAt: string;
  /** Set while models.dev lists no model of the provider; the last known row stays. */
  unlistedAt: string | null;
  updatedAt: string;
};

export type StoredModel = ReducedModel & {
  firstSeenAt: string;
  /** Set while models.dev no longer lists the model: the last known entry is kept and jobs still get it. */
  unlistedAt: string | null;
  updatedAt: string;
};

/** The rows one fetch writes: new or changed ones only, whole, never a delete. */
export type CatalogWrite = {
  providers: StoredProvider[];
  models: StoredModel[];
};

export type FetchSummary = Record<string, number>;

export type FetchState = {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastStatus: "ok" | "failed";
  lastError: ModelsDevFetchErrorCode | null;
  lastSummary: FetchSummary | null;
};

export type { UrlProblem };
