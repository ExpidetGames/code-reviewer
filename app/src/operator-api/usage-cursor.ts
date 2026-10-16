// SPDX-License-Identifier: Apache-2.0

// The cursor of the usage feed (#278): where a reader stopped in the settled records, as text the reader keeps
// and hands back without looking inside. Opaque to the caller, validated here: a bounded base64url text that
// decodes to exactly one version number, one time of settlement and one record id, and that is what
// `encodeUsageCursor` writes for them (anything else is refused, so a client cannot make up a position).
import type { UsageCursor } from "../db/repositories/usage-records-repository.ts";
import {
  MAX_USAGE_CURSOR_LENGTH,
  OPERATOR_ID_PATTERN,
  isTimestamp,
} from "./contract.ts";

const VERSION = "1";
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function encodeUsageCursor(position: UsageCursor): string {
  return Buffer.from(
    `${VERSION}|${position.settledAt}|${position.id}`,
  ).toString("base64url");
}

/** The position a cursor names, or null for text that is not a cursor of this API. Never throws. */
export function decodeUsageCursor(text: string): UsageCursor | null {
  if (text.length === 0 || text.length > MAX_USAGE_CURSOR_LENGTH) return null;
  if (!BASE64URL.test(text)) return null;
  const parts = Buffer.from(text, "base64url").toString("utf8").split("|");
  if (parts.length !== 3) return null;
  const [version, settledAt, id] = parts;
  if (version !== VERSION || settledAt === undefined || id === undefined)
    return null;
  if (!isTimestamp(settledAt) || !OPERATOR_ID_PATTERN.test(id)) return null;
  const position = { settledAt, id };
  return encodeUsageCursor(position) === text ? position : null;
}

const MIN_SAFETY_LAG_MS = 1_000;
const MAX_SAFETY_LAG_MS = 3_600_000;

/** The safety lag, or a thrown error for a value that would defeat its purpose (zero) or hide records for hours. */
export function validateSafetyLagMs(value: number): number {
  if (
    !Number.isInteger(value) ||
    value < MIN_SAFETY_LAG_MS ||
    value > MAX_SAFETY_LAG_MS
  )
    throw new RangeError(
      `The usage safety lag must be a whole number of milliseconds from ${MIN_SAFETY_LAG_MS} to ${MAX_SAFETY_LAG_MS}.`,
    );
  return value;
}
