// SPDX-License-Identifier: Apache-2.0

// What the check run and the verdict of a review read from the result its job stored (#405): the link to the
// review comment, the findings left open and why a Dynamic review stopped early. The result was checked when the
// runner reported it, but a row of an earlier release has no findings and a row can have been changed by hand, so
// every field is checked again; whatever is not what it should be is "not said" and never an error.
import type { JsonValue } from "../integrations/types.ts";
import {
  FINDING_PRIORITIES,
  MAX_FINDING_COUNT,
  STOPPED_EARLY_REASONS,
  type ReviewFindings,
} from "../runner-api/contract.ts";

export type ResultFacts = {
  commentUrl: string | null;
  findings: ReviewFindings | null;
  stoppedEarly: string | null;
};

type Record_ = Record<string, JsonValue>;

function isRecord(value: JsonValue | undefined): value is Record_ {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: JsonValue | undefined): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_FINDING_COUNT
  );
}

function readFindings(value: JsonValue | undefined): ReviewFindings | null {
  if (!isRecord(value) || !isCount(value.open)) return null;
  const counts = value.bySeverity;
  if (counts === null) return { open: value.open, bySeverity: null };
  if (!isRecord(counts)) return null;
  const [p0, p1, p2, p3] = FINDING_PRIORITIES.map(
    (priority) => counts[priority],
  );
  if (!isCount(p0) || !isCount(p1) || !isCount(p2) || !isCount(p3)) return null;
  return { open: value.open, bySeverity: { P0: p0, P1: p1, P2: p2, P3: p3 } };
}

export function readResultFacts(result: JsonValue | null): ResultFacts {
  if (!isRecord(result ?? undefined))
    return { commentUrl: null, findings: null, stoppedEarly: null };
  const record = result as Record_;
  const usage = record.usage;
  const stoppedEarly = isRecord(usage) ? usage.stoppedEarly : undefined;
  return {
    commentUrl:
      typeof record.commentUrl === "string" ? record.commentUrl : null,
    findings: readFindings(record.findings),
    stoppedEarly:
      typeof stoppedEarly === "string" &&
      (STOPPED_EARLY_REASONS as readonly string[]).includes(stoppedEarly)
        ? stoppedEarly
        : null,
  };
}
