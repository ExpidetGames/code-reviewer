// SPDX-License-Identifier: LicenseRef-Proprietary

// The capabilities of a deployment (#731). One codebase is deployed more than once (code-review.com and a clone
// with another product); what a deployment offers is its capability set. A feature outside the set has no route,
// no navigation entry, no API endpoint and no background work: it is not switched off at run time, it is absent.
// This module is pure (no environment, no imports), so the proxy, the pages, the jobs and the tests share it.

/**
 * Every capability a deployment can have. `implementer` is reserved for the Software Factory: it is known so that a
 * product which does not allow it refuses it by name, but nothing is gated by it yet.
 */
export const CAPABILITIES = [
  "review",
  "dynamic-review",
  "billing",
  "implementer",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

/** The capability that a capability cannot exist without. */
const REQUIRES: Partial<Record<Capability, Capability>> = {
  "dynamic-review": "review",
};

export function requiredCapability(
  capability: Capability,
): Capability | undefined {
  return REQUIRES[capability];
}

/** The review kinds of a job and the capability each needs (the job kind lives in src/job-kind/job-kind.ts). */
export const CAPABILITY_OF_REVIEW_KIND = {
  diff: "review",
  dynamic: "dynamic-review",
} as const satisfies Record<string, Capability>;

export type CapabilitySet = {
  has(capability: Capability): boolean;
  /** In the order of `CAPABILITIES`, so the answer of the health check is stable. */
  list(): Capability[];
  /** Whether a job of this review kind may exist in this deployment. */
  allowsReviewKind(kind: keyof typeof CAPABILITY_OF_REVIEW_KIND): boolean;
};

export function createCapabilitySet(
  capabilities: Iterable<Capability>,
): CapabilitySet {
  const members = new Set(capabilities);
  return {
    has: (capability) => members.has(capability),
    list: () => CAPABILITIES.filter((capability) => members.has(capability)),
    allowsReviewKind: (kind) => members.has(CAPABILITY_OF_REVIEW_KIND[kind]),
  };
}
