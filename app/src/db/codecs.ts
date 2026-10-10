// Portable column conventions (see README.md in this folder). Every repository converts between
// application values and column values through these helpers, so the encodings live in one place.

/** JSON columns hold the serialized value as text. */
export function encodeJson(value: unknown): string {
  const text = JSON.stringify(value);
  // JSON.stringify returns undefined (not a string) for undefined, functions and symbols. Storing
  // that would silently drop the column from an insert, so refuse it here. Use null for "no value".
  if (text === undefined)
    throw new Error("Value cannot be stored as JSON (use null for no value).");
  return text;
}

export function decodeJson<T = unknown>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new Error("Stored value is not valid JSON.", { cause });
  }
}

/** Boolean columns are integers: 1 for true, 0 for false. */
export function encodeBoolean(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

export function decodeBoolean(value: number): boolean {
  if (value === 1) return true;
  if (value === 0) return false;
  throw new Error(`Stored value ${value} is not a boolean (expected 0 or 1).`);
}

/** Timestamp columns are ISO 8601 text in UTC, for example 2026-10-10T12:30:15.042Z. */
export function formatTimestamp(date: Date): string {
  return date.toISOString();
}
