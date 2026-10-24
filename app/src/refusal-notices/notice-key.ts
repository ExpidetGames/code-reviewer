// SPDX-License-Identifier: LicenseRef-Proprietary

// What a notice is recorded under (the `period_start` column of `refusal_notices`, #281). A limit or a suspension is decided
// for a period, and the notice is one per pull request and period. A refusal for the balance (#498) has no period: it
// is one per pull request **head**, so a push after the customer topped up and was refused again is told once more, and a
// second review of the same head is not. The key is `head:` and the commit id, which GitHub names with hex digits only, so
// it holds nothing that could end the comment early (it goes into the hidden marker).

const HEAD_PREFIX = "head:";
const HEAD_PATTERN = /^[0-9a-f]{7,64}$/;

/** The key of a notice about one pull request head, or undefined for a value that is no commit id. */
export function headNoticeKey(headSha: string): string | undefined {
  return HEAD_PATTERN.test(headSha) ? `${HEAD_PREFIX}${headSha}` : undefined;
}
