// SPDX-License-Identifier: Apache-2.0

// What the balance banner of the workspace pages knows (#506): plain data the server works out and the page renders, free of
// server code like the rest of this folder. The banner is for Owners and Admins only and shows while the balance is low, zero or
// below zero. It carries the workspace's own balance and the way to the billing page, nothing about how a review is priced.

export const BANNER_LEVELS = ["low", "empty", "negative"] as const;
export type BannerLevel = (typeof BANNER_LEVELS)[number];

export type BalanceBannerView = {
  level: BannerLevel;
  /** Whole micro-USD; at most the low-balance threshold. */
  balanceMicroUsd: number;
  /** The billing page of the workspace (`/w/<slug>/settings/billing`). */
  billingHref: string;
};
