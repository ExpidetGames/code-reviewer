// SPDX-License-Identifier: Apache-2.0

// The part of a payment's credit that a refund or dispute takes back (ADR 0006, 2.12 and 2.13; #497).
//
// A provider reports a refund or a dispute as a share of the GROSS payment: tax included, in the currency the buyer paid
// in. The ledger holds the NET credit in USD, and the provider tells nothing of the tax split of a refund. The share is a
// ratio and a ratio does not depend on the currency, the unit or the tax, so the adapter hands over the provider's
// `amount` and the provider's `paymentAmount` of the whole payment (both in the same unit, whatever it is) and this
// function turns them into micro-USD of the credit:
//
//   debit = floor(credited x amount / paymentAmount)
//
// Whole numbers only (BigInt, so a large product loses nothing), and ROUNDING DOWN: the shares of one payment then add up
// to at most the credit, never to a micro-USD more, and the whole payment (`amount == paymentAmount`) takes exactly what
// was credited. The sub micro-USD remainder stays with the buyer.
import "server-only";

function isWhole(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * The debit in micro-USD, or undefined when there is none to compute: a number that is not a positive whole number, an
 * amount above the payment (the provider contradicts itself) or a share that rounds down to nothing.
 */
export function netShareMicroUsd(input: {
  credited: number;
  amount: number;
  paymentAmount: number;
}): number | undefined {
  const { credited, amount, paymentAmount } = input;
  if (!isWhole(credited) || !isWhole(amount) || !isWhole(paymentAmount))
    return undefined;
  if (amount > paymentAmount) return undefined;
  const share = (BigInt(credited) * BigInt(amount)) / BigInt(paymentAmount);
  return share === BigInt(0) ? undefined : Number(share);
}
