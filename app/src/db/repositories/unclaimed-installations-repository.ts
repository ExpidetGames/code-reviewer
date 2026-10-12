// SPDX-License-Identifier: Apache-2.0

// Installations of the GitHub App that no workspace has linked (docs/decisions/0001-editions-setup-and-
// accounts.md, section 2.9). INSTANCE LEVEL: an unclaimed installation belongs to nobody, which is the point.
// The app-wide installation listing of the sync and a delivery about a new installation note them here and
// create nothing else; linking one (src/installation-binding/) removes the note.
import "server-only";
import type { Kysely } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database, UnclaimedInstallationsTable } from "../schema.ts";

export const UNCLAIMED_SOURCES = ["webhook", "sync"] as const;
export type UnclaimedSource = (typeof UNCLAIMED_SOURCES)[number];

export type UnclaimedInstallation = {
  installationId: string;
  accountLogin: string;
  accountType: string;
  firstSeenAt: string;
  lastSeenAt: string;
  source: UnclaimedSource;
};

export type UnclaimedInstallationsRepository = {
  /** Notes the installation (again): the first time it was seen stays, the last time moves. */
  record(input: {
    installationId: string;
    accountLogin: string;
    accountType: string;
    source: UnclaimedSource;
  }): Promise<void>;
  /** Forgets the installation: it was linked, or it is gone. */
  forget(installationId: string): Promise<void>;
  get(installationId: string): Promise<UnclaimedInstallation | undefined>;
  list(): Promise<UnclaimedInstallation[]>;
};

function toUnclaimed(row: UnclaimedInstallationsTable): UnclaimedInstallation {
  return {
    installationId: row.installation_id,
    accountLogin: row.account_login,
    accountType: row.account_type,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    source: UNCLAIMED_SOURCES.find((value) => value === row.source) ?? "sync",
  };
}

export function createUnclaimedInstallationsRepository(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
): UnclaimedInstallationsRepository {
  return {
    async record(input) {
      const at = formatTimestamp(now());
      await db
        .insertInto("unclaimed_installations")
        .values({
          installation_id: input.installationId,
          account_login: input.accountLogin,
          account_type: input.accountType,
          first_seen_at: at,
          last_seen_at: at,
          source: input.source,
        })
        .onConflict((conflict) =>
          conflict.column("installation_id").doUpdateSet({
            account_login: input.accountLogin,
            account_type: input.accountType,
            last_seen_at: at,
          }),
        )
        .execute();
    },

    async forget(installationId) {
      await db
        .deleteFrom("unclaimed_installations")
        .where("installation_id", "=", installationId)
        .execute();
    },

    async get(installationId) {
      const row = await db
        .selectFrom("unclaimed_installations")
        .selectAll()
        .where("installation_id", "=", installationId)
        .executeTakeFirst();
      return row === undefined ? undefined : toUnclaimed(row);
    },

    async list() {
      const rows = await db
        .selectFrom("unclaimed_installations")
        .selectAll()
        .orderBy("first_seen_at")
        .orderBy("installation_id")
        .execute();
      return rows.map(toUnclaimed);
    },
  };
}
