// SPDX-License-Identifier: Apache-2.0

// What the operator API says about usage: named fields only, built one by one so that a column added to the table
// later never reaches the outside by accident. No pull request, repository, branch, title or person is in a
// record, and the model of a managed tier is only ever its tier name. The shapes are the definitions `UsageItem`
// and `UsageSummaryResponse` of the contract.
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
    modelTier: record.modelTier,
    costMicroUsd: record.costMicroUsd,
    promptTokens: record.promptTokens,
    completionTokens: record.completionTokens,
    // A settled record always has its time (a check of the table); null is only for the type.
    settledAt: record.settledAt,
    // The table keeps no reason yet (#273 adds `no_result`); the field is part of the format from the start.
    reason: null,
  };
}

export function usageSummaryGroupView(group: UsageSummaryGroup) {
  return {
    reviewKind: group.reviewKind,
    keyMode: group.keyMode,
    recordCount: group.recordCount,
    settledCount: group.settledCount,
    knownCostMicroUsd: group.knownCostMicroUsd,
    unknownCostCount: group.unknownCostCount,
  };
}
