// SPDX-License-Identifier: LicenseRef-Proprietary

// The billing profile of ONE workspace (table `billing_profiles`; the factory takes the workspace id, see
// ../workspace-scope.ts; ADR 0006, 2.13; #501; src/billing/README.md): the business that buys credit, the confirmation
// of the first top-up and the provider's customer made from the profile. Customer data: a method returns it to the
// caller and nothing here logs it. A Member never gets it; that is the service's rule (`src/billing/profile-service.ts`),
// since the repository knows no role.
//
// There is at most one profile per workspace. `updatedAt` is the time of the last edit of the CONTENT; the confirmation
// and the customer have their own fields and do not move it.
import "server-only";
import type { Kysely, Selectable } from "kysely";
import { isAdapterId, isProviderRef } from "../../billing/adapter.ts";
import type { BillingProfileInput } from "../../billing/profile.ts";
import { formatTimestamp } from "../codecs.ts";
import type { BillingProfilesTable, Database } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";

/** A stored profile: the content, the business confirmation and the provider's customer, if any. */
export type StoredBillingProfile = BillingProfileInput & {
  /** When the business confirmation was given (ISO 8601, UTC), or null before the first top-up. */
  confirmedAt: string | null;
  /** The user who gave it; null before it, or once that user is gone. */
  confirmedBy: string | null;
  termsVersion: string | null;
  /** The adapter's id and its opaque id of the customer made from this profile; both null until the first top-up. */
  customerAdapter: string | null;
  customerRef: string | null;
  createdAt: string;
  updatedAt: string;
};

function toProfile(
  row: Selectable<BillingProfilesTable>,
): StoredBillingProfile {
  return {
    legalName: row.legal_name,
    country: row.country,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    postalCode: row.postal_code,
    city: row.city,
    vatId: row.vat_id,
    confirmedAt: row.confirmed_at,
    confirmedBy: row.confirmed_by,
    termsVersion: row.terms_version,
    customerAdapter: row.customer_adapter,
    customerRef: row.customer_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type BillingProfilesRepository = {
  get(): Promise<StoredBillingProfile | undefined>;
  /** Creates the profile or replaces its content; the confirmation and the customer stay. */
  save(input: BillingProfileInput): Promise<StoredBillingProfile>;
  /**
   * Records the business confirmation of the first top-up. Once given it is never replaced: a second call returns the
   * profile as it is. Undefined when the workspace has no profile yet.
   */
  confirmBusiness(confirmation: {
    userId: string;
    termsVersion: string;
  }): Promise<StoredBillingProfile | undefined>;
  /**
   * Records the provider's customer made from this profile (an adapter id and an opaque id), replacing another: a
   * customer the provider no longer knows is made again. Undefined when the workspace has no profile.
   */
  setCustomer(
    adapter: string,
    customerRef: string,
  ): Promise<StoredBillingProfile | undefined>;
};

export function createBillingProfilesRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
): BillingProfilesRepository {
  async function find(): Promise<StoredBillingProfile | undefined> {
    const row = await db
      .selectFrom("billing_profiles")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
    return row === undefined ? undefined : toProfile(row);
  }

  return {
    get: find,

    async save(input) {
      const timestamp = formatTimestamp(now());
      const content = {
        legal_name: input.legalName,
        country: input.country,
        address_line1: input.addressLine1,
        address_line2: input.addressLine2,
        postal_code: input.postalCode,
        city: input.city,
        vat_id: input.vatId,
        updated_at: timestamp,
      };
      const row = await db
        .insertInto("billing_profiles")
        .values({
          workspace_id: workspaceId,
          ...content,
          created_at: timestamp,
        })
        .onConflict((conflict) =>
          conflict.column("workspace_id").doUpdateSet(content),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      return toProfile(row);
    },

    async confirmBusiness({ userId, termsVersion }) {
      await db
        .updateTable("billing_profiles")
        .set({
          confirmed_at: formatTimestamp(now()),
          confirmed_by: userId,
          terms_version: termsVersion,
        })
        .where("workspace_id", "=", workspaceId)
        .where("confirmed_at", "is", null)
        .execute();
      return find();
    },

    async setCustomer(adapter, customerRef) {
      if (!isAdapterId(adapter)) throw new TypeError("not an adapter id");
      if (!isProviderRef(customerRef))
        throw new TypeError("not an opaque provider id");
      await db
        .updateTable("billing_profiles")
        .set({ customer_adapter: adapter, customer_ref: customerRef })
        .where("workspace_id", "=", workspaceId)
        .execute();
      return find();
    },
  };
}
