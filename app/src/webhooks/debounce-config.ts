// SPDX-License-Identifier: LicenseRef-Proprietary

// `REVIEW_DEBOUNCE_SECONDS` is retired (#395): a push no longer waits before its automatic review starts. The
// variable has no effect; a server that still has it set says so once when it starts (`warnAboutDebounce`,
// called from `src/instrumentation.ts` and the serverless start), naming the variable and never the value.
export const DEBOUNCE_VARIABLE = "REVIEW_DEBOUNCE_SECONDS";

type Env = Readonly<Record<string, string | undefined>>;

/** The line to log when the retired variable is set, else null. Never holds the value. */
export function debounceWarning(env: Env): string | null {
  const raw = env[DEBOUNCE_VARIABLE]?.trim();
  if (raw === undefined || raw === "") return null;
  return `[webhook] ${DEBOUNCE_VARIABLE} has no effect any more: a push starts its automatic review at once. Remove the variable.`;
}

export function warnAboutDebounce(
  env: Env,
  log: (line: string) => void = (line) => console.warn(line),
): void {
  const line = debounceWarning(env);
  if (line !== null) log(line);
}
