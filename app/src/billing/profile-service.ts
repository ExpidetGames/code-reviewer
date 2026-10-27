// SPDX-License-Identifier: LicenseRef-Proprietary

// The billing profile of a workspace for the code that serves a person (ADR 0006, 2.13; #501): who may read and write it,
// and what leaves. Only an Owner and an Admin (`manage_billing`) reach it; a Member gets `forbidden` and nothing of the
// profile, and nothing is stored for them. What is handed out is the content and whether the business confirmed; the
// provider's customer id and the user who confirmed stay in the repository. Nothing here logs, and an error names a field
// and a code, never a value.
import "server-only";
import type { Kysely } from "kysely";
import {
  createBillingProfilesRepository,
  type StoredBillingProfile,
} from "../db/repositories/billing-profiles-repository.ts";
import type { Database } from "../db/schema.ts";
import { can } from "../workspaces/permissions.ts";
import type { WorkspaceRole } from "../db/workspace-roles.ts";
import {
  validateBillingProfileInput,
  type BillingProfileInput,
  type BillingProfileIssue,
} from "./profile.ts";

/** Who asks, in which workspace: from the access check of the request, never from its body. */
export type BillingActor = {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
};

export type BillingProfileView = BillingProfileInput & {
  /** The business confirmation of the first top-up was given. */
  businessConfirmed: boolean;
  confirmedAt: string | null;
  updatedAt: string;
};

export function viewOf(profile: StoredBillingProfile): BillingProfileView {
  return {
    legalName: profile.legalName,
    country: profile.country,
    addressLine1: profile.addressLine1,
    addressLine2: profile.addressLine2,
    postalCode: profile.postalCode,
    city: profile.city,
    vatId: profile.vatId,
    businessConfirmed: profile.confirmedAt !== null,
    confirmedAt: profile.confirmedAt,
    updatedAt: profile.updatedAt,
  };
}

export type BillingProfileService = {
  /** The profile, or null when none was saved yet. */
  get(
    actor: BillingActor,
  ): Promise<
    | { ok: true; profile: BillingProfileView | null }
    | { ok: false; error: "forbidden" }
  >;
  save(
    actor: BillingActor,
    body: unknown,
  ): Promise<
    | { ok: true; profile: BillingProfileView }
    | { ok: false; error: "forbidden" }
    | { ok: false; error: "invalid_input"; issues: BillingProfileIssue[] }
  >;
};

export function createBillingProfileService({
  db,
  now,
}: {
  db: Kysely<Database>;
  now?: () => Date;
}): BillingProfileService {
  const repositoryOf = (workspaceId: string) =>
    createBillingProfilesRepository(db, workspaceId, now);
  return {
    async get(actor) {
      if (!can(actor.role, "manage_billing"))
        return { ok: false, error: "forbidden" };
      const profile = await repositoryOf(actor.workspaceId).get();
      return {
        ok: true,
        profile: profile === undefined ? null : viewOf(profile),
      };
    },

    async save(actor, body) {
      if (!can(actor.role, "manage_billing"))
        return { ok: false, error: "forbidden" };
      const input = validateBillingProfileInput(body);
      if (!input.ok)
        return { ok: false, error: "invalid_input", issues: input.issues };
      return {
        ok: true,
        profile: viewOf(
          await repositoryOf(actor.workspaceId).save(input.value),
        ),
      };
    },
  };
}
