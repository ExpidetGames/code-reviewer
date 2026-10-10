// Reads how long a push waits before its automatic review may start. The only place that knows the
// variable name. A value that is not a whole number of seconds from 0 to 600 is ignored and the
// default is used: a typo must not stop every review. The server says so once when it starts
// (`warnAboutDebounce`, called from `src/instrumentation.ts`), naming the variable and never the value.
import { AUTOMATIC_REVIEW_DEBOUNCE_MS } from "./automatic-review-policy.ts";

export const DEBOUNCE_VARIABLE = "REVIEW_DEBOUNCE_SECONDS";
const MAX_DEBOUNCE_SECONDS = 600;

type Env = Readonly<Record<string, string | undefined>>;

/** The configured wait in whole seconds, `null` when unset, `"invalid"` when the value is unusable. */
function parsed(env: Env): number | null | "invalid" {
  const raw = env[DEBOUNCE_VARIABLE]?.trim();
  if (raw === undefined || raw === "") return null;
  if (!/^\d{1,3}$/.test(raw)) return "invalid";
  const seconds = Number(raw);
  return seconds > MAX_DEBOUNCE_SECONDS ? "invalid" : seconds;
}

export function configuredDebounceMs(env: Env): number {
  const seconds = parsed(env);
  if (seconds === null || seconds === "invalid")
    return AUTOMATIC_REVIEW_DEBOUNCE_MS;
  return seconds * 1000;
}

/** The line to log when the variable is set to something unusable, else null. Never holds the value. */
export function debounceWarning(env: Env): string | null {
  if (parsed(env) !== "invalid") return null;
  return `[webhook] ${DEBOUNCE_VARIABLE} is not a whole number of seconds from 0 to ${MAX_DEBOUNCE_SECONDS}: the default of ${AUTOMATIC_REVIEW_DEBOUNCE_MS / 1000} seconds is used.`;
}

export function warnAboutDebounce(
  env: Env,
  log: (line: string) => void = (line) => console.warn(line),
): void {
  const line = debounceWarning(env);
  if (line !== null) log(line);
}
