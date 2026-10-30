// SPDX-License-Identifier: LicenseRef-Proprietary

// #746: the kinds of job the claim builds an input for. The contract knows one more kind than the claim does today
// (`implementer`, built by the claim of the Implementer, #753). A job of a kind the claim does not build is refused with a
// stable code before any credential exists; it is never built as a Diff job, which is what a branch on `dynamic` alone would do.
import type { ReviewKind } from "./contract.ts";

/** The stable code of the refusal of a kind the claim does not build. */
export const UNBUILT_KIND_CODE = "implementer_engine_unavailable";

/** The refusal for a job of this kind, or null when the claim builds it. */
export function refusalForKind(
  kind: ReviewKind,
): typeof UNBUILT_KIND_CODE | null {
  return kind === "implementer" ? UNBUILT_KIND_CODE : null;
}
