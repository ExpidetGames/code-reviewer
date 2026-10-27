// SPDX-License-Identifier: LicenseRef-Proprietary

// The states a balance can be in for the notifications of #506, and nothing else (no database, no mail), so the repositories and
// the pages share one reading. A balance is `empty` at zero or below (a review starts with any balance above zero, #605, so
// zero is where reviews are refused), `low` below the threshold the admin set, and `ok` otherwise. A balance below zero is empty
// as far as mail goes (one "empty" mail), but the banner and the page tell it apart (`negative`).
import "server-only";

/** The two things a workspace is told, in the order the more serious one comes first. */
export const BALANCE_NOTIFICATION_KINDS = ["empty", "low"] as const;
export type BalanceNotificationKind =
  (typeof BALANCE_NOTIFICATION_KINDS)[number];

/** `armed`: the next drop into the state is told. `sent`: told (or known) since the balance was last out of the state. */
export const BALANCE_NOTIFICATION_STATES = ["armed", "sent"] as const;
export type BalanceNotificationState =
  (typeof BALANCE_NOTIFICATION_STATES)[number];

/**
 * The mail of a crossing: `due` is written in the transaction that moved the balance, `sending` is one process's claim of it,
 * `delivered` or `failed` is what that process found out. `none`: no mail (no crossing, or a credit that landed in the state).
 */
export const BALANCE_MAIL_DELIVERIES = [
  "none",
  "due",
  "sending",
  "delivered",
  "failed",
] as const;
export type BalanceMailDelivery = (typeof BALANCE_MAIL_DELIVERIES)[number];

export type BalanceLevel = "ok" | "low" | "empty" | "negative";

/**
 * Where a balance stands against the threshold (micro-USD). A threshold of zero or less never makes a positive balance low:
 * the admin who sets it to 0 has no low state, only the empty one.
 */
export function balanceLevelOf(
  balanceMicroUsd: number,
  lowBalanceMicroUsd: number,
): BalanceLevel {
  if (balanceMicroUsd < 0) return "negative";
  if (balanceMicroUsd === 0) return "empty";
  return balanceMicroUsd < lowBalanceMicroUsd ? "low" : "ok";
}

/** The kinds a balance is in: empty and negative are both `empty` (and also low), low is `low`. */
export function kindsInStateOf(
  balanceMicroUsd: number,
  lowBalanceMicroUsd: number,
): Record<BalanceNotificationKind, boolean> {
  const level = balanceLevelOf(balanceMicroUsd, lowBalanceMicroUsd);
  return {
    empty: level === "empty" || level === "negative",
    low: level !== "ok",
  };
}
