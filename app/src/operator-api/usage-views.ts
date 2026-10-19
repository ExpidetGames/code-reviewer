// SPDX-License-Identifier: Apache-2.0

// What the operator API says about usage: named fields only, built one by one so that a column added to the table
// later never reaches the outside by accident. No pull request, repository, branch, title or person is in a
// record, and the model of a managed run is only ever its entry (or, for a run from before the catalog, its tier name). The shapes are the definitions `UsageItem`
// and `UsageSummaryResponse` of the contract.
import { MAX_NAME_CHARS } from "../model-catalog/entries.ts";
import { ENTRY_ID_PATTERN, TIER_NAME_PATTERN } from "./contract.ts";
import type { UnknownCostCount } from "../db/repositories/usage-feed-repository.ts";
import type {
  UsageRecord,
  UsageSummaryGroup,
} from "../db/repositories/usage-records-repository.ts";

export function usageItemView(record: UsageRecord) {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    jobId: record.jobId,
    reviewKind: record.reviewKind,
    keyMode: record.keyMode,
    // Whatever is stored, only a tier name leaves the app: a value that is not one is served as null.
    modelTier:
      record.modelTier !== null && TIER_NAME_PATTERN.test(record.modelTier)
        ? record.modelTier
        : null,
    // #432: the entry a managed run used, by id and name (the name as it was at the claim). Never the provider or the
    // model; a value that is not the shape of an id or a name is served as null.
    catalogEntryId:
      record.catalogEntryId !== null &&
      ENTRY_ID_PATTERN.test(record.catalogEntryId)
        ? record.catalogEntryId
        : null,
    catalogEntryName:
      record.catalogEntryName !== null &&
      record.catalogEntryName.length <= MAX_NAME_CHARS
        ? record.catalogEntryName
        : null,
    costMicroUsd: record.costMicroUsd,
    promptTokens: record.promptTokens,
    completionTokens: record.completionTokens,
    // A settled record always has its time (a check of the table); null is only for the type.
    settledAt: record.settledAt,
    // `no_result` (#273): the job ended without any result from the runner, so the measurement is unknown. A run that
    // reported its usage, failed or not, carries its measurement and no reason; its unknown cost is a null cost.
    reason: record.settledReason,
  };
}

export function usageSummaryGroupView(group: UsageSummaryGroup) {
  return {
    reviewKind: group.reviewKind,
    keyMode: group.keyMode,
    recordCount: group.recordCount,
    settledCount: group.settledCount,
    supersededCount: group.supersededCount,
    knownCostMicroUsd: group.knownCostMicroUsd,
    unknownCostCount: group.unknownCostCount,
  };
}

/** A plain integer for a workspace and a key mode: no cost, model, key or name (#385). Shape: `UnknownCostCount`. */
export function unknownCostCountView(count: UnknownCostCount) {
  return {
    workspaceId: count.workspaceId,
    keyMode: count.keyMode,
    unknownCostCount: count.unknownCostCount,
  };
}
