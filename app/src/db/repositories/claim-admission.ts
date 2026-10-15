// SPDX-License-Identifier: Apache-2.0

// The admission of a claimed job (#277): inside the transaction of the queue's claim, after a job was taken and
// before its usage record is reserved, it resolves the entitlements of the job's workspace and decides whether
// the job may run (`decideAdmission`, src/usage/enforce-entitlements.ts). INSTANCE LEVEL like the claim it
// belongs to: it serves whichever workspace the oldest due job is in, and every statement it makes goes through
// repositories created for that workspace.
//
// Exactness: the claim runs under the exclusive gate lock of the queue (Postgres) or the write lock of the
// connection (SQLite), so two claims never read the count at once. On Postgres the workspace row is locked as
// well (`for no key update`, which an insert that only references the row does not wait on), so the count stays
// exact if the gate is ever narrowed. A workspace without limits reads no usage and takes no lock.
import "server-only";
import { sql, type Kysely, type Selectable } from "kysely";
import {
  decideAdmission,
  ignoresCostLimit,
  readsUsage,
  type Admission,
  type AdmissionUsage,
} from "../../usage/enforce-entitlements.ts";
import { databaseDriver } from "../driver.ts";
import type { Database, JobsTable } from "../schema.ts";
import { createUsageRecordsRepository } from "./usage-records-repository.ts";
import type { ProjectReviewKind } from "../../review-settings/settings.ts";
import { readEffectiveEntitlements } from "../../workspaces/effective-entitlements.ts";

/** What the claim did to a job it refused; handed to `onRefused` once the transaction has committed. */
export type ClaimRefusal = {
  jobId: string;
  workspaceId: string;
  errorCode: string;
  detail?: string;
};

/** The decision and whether the job already had a usage record (a job claimed again after a lost lease). */
export type ClaimAdmission = {
  admission: Admission;
  hadRecord: boolean;
  /** The entitlements hold a cost limit next to the own key, which nothing reads (#277). */
  ignoredCostLimit: boolean;
};

export async function admitClaimedJob(
  trx: Kysely<Database>,
  job: Pick<Selectable<JobsTable>, "id" | "workspace_id" | "review_kind">,
  now: () => Date,
): Promise<ClaimAdmission> {
  const workspaceId = job.workspace_id;
  const records = createUsageRecordsRepository(trx, workspaceId, now);
  const own = await records.get(job.id);
  const hadRecord = own !== undefined;

  const entitlements = await readEffectiveEntitlements(trx, workspaceId, now);
  if (entitlements.kind === "unlimited")
    return { admission: { allow: true }, hadRecord, ignoredCostLimit: false };
  const ignoredCostLimit = ignoresCostLimit(entitlements);

  const reviewKind = job.review_kind as ProjectReviewKind;
  // A limit that applies to this job is the only reason to count and to lock; a suspension needs neither.
  if (
    readsUsage(entitlements, reviewKind) &&
    databaseDriver(trx) === "postgres"
  )
    await sql`select id from workspaces where id = ${workspaceId} for no key update`.execute(
      trx,
    );

  const usage: AdmissionUsage = {
    // A job claimed again keeps its record and is not counted twice: its own unit is not held against it.
    async runsSince(kind, since) {
      const counted = (await records.countByKind(since))[kind];
      const ownCounts =
        own !== undefined &&
        own.reviewKind === kind &&
        own.state !== "void" &&
        own.reservedAt >= since;
      return ownCounts ? counted - 1 : counted;
    },
    managedCostSince: (since) => records.sumSettledManagedCostMicroUsd(since),
  };
  return {
    admission: await decideAdmission(entitlements, reviewKind, usage),
    hadRecord,
    ignoredCostLimit,
  };
}
