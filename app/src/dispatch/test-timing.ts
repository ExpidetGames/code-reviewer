// SPDX-License-Identifier: LicenseRef-Proprietary

// The pauses of the inline retries of a wake-up (`INLINE_RETRY_DELAYS_MS`, #395) for a test lane that has to give a
// Dispatcher it starts itself more time than a slow runner may need. Honoured only with
// `ALLOW_TEST_DISPATCH_TIMING=true`, like the other `ALLOW_TEST_*` flags; a real deployment never sets either variable
// (the compose files do not pass them on), and a value that is not a short list of pauses is ignored.
type Env = Readonly<Record<string, string | undefined>>;

const MAX_PAUSES = 5;
const MAX_PAUSE_MS = 10_000;

export function testInlineRetryDelays(env: Env): readonly number[] | undefined {
  if (env.ALLOW_TEST_DISPATCH_TIMING !== "true") return undefined;
  const raw = env.TEST_DISPATCH_INLINE_RETRY_DELAYS_MS?.trim();
  if (raw === undefined || raw === "") return undefined;
  const pauses = raw.split(",").map((part) => part.trim());
  if (pauses.length > MAX_PAUSES || !pauses.every((p) => /^\d{1,5}$/.test(p)))
    return undefined;
  const delays = pauses.map(Number);
  return delays.every((ms) => ms <= MAX_PAUSE_MS) ? delays : undefined;
}
