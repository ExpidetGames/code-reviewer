// SPDX-License-Identifier: LicenseRef-Proprietary

// Reading one value of a page's search params (Next.js gives a `string`, an array for a repeated
// parameter, or `undefined`). A value that is not a single non-empty string counts as absent, so a
// page never shows a repeated or empty parameter as an outcome.
export function singleSearchParam(
  value: string | string[] | undefined,
): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
