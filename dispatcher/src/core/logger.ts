// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Logger } from "./types.ts";

const REDACTED = "[redacted]";
// A per-job credential (`crj_` and 43 characters of base64url) and an Authorization value, wherever
// they turn up: the secrets we know of are masked by value, these are masked by shape.
const SHAPES = [/crj_[A-Za-z0-9_-]{8,}/g, /Bearer\s+[^\s"',;]+/gi];

/** The text with every known secret and every secret-shaped value replaced. */
export function redact(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets)
    if (secret.length >= 8) result = result.split(secret).join(REDACTED);
  for (const shape of SHAPES) result = result.replace(shape, REDACTED);
  return result;
}

/**
 * A Logger over one line writer. Every line goes through `redact`, so a credential in a field or in an
 * error message of a Launcher cannot reach the log, whatever the caller did.
 */
export function createLogger(
  write: (line: string) => void,
  secrets: readonly string[],
): Logger {
  const emit = (
    level: string,
    event: string,
    fields?: Record<string, unknown>,
  ) => {
    const line = JSON.stringify({ level, event, ...fields });
    write(redact(line, secrets));
  };
  return {
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}
