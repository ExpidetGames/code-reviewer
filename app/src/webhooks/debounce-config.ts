// Reads how long a push waits before its automatic review may start. The only place that knows the
// variable name. A value that is not a whole number of seconds from 0 to 600 is ignored and the
// default is used: a typo must not stop every review.
import { AUTOMATIC_REVIEW_DEBOUNCE_MS } from "./automatic-review-policy.ts";

export const DEBOUNCE_VARIABLE = "REVIEW_DEBOUNCE_SECONDS";
const MAX_DEBOUNCE_SECONDS = 600;

export function configuredDebounceMs(
  env: Record<string, string | undefined>,
): number {
  const raw = env[DEBOUNCE_VARIABLE]?.trim();
  if (raw === undefined || raw === "") return AUTOMATIC_REVIEW_DEBOUNCE_MS;
  if (!/^\d{1,3}$/.test(raw)) return AUTOMATIC_REVIEW_DEBOUNCE_MS;
  const seconds = Number(raw);
  if (seconds > MAX_DEBOUNCE_SECONDS) return AUTOMATIC_REVIEW_DEBOUNCE_MS;
  return seconds * 1000;
}
