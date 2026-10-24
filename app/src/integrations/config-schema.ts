// SPDX-License-Identifier: LicenseRef-Proprietary

// A tiny validator for the `config` JSON of an integration, so every provider can declare its
// fields in a few lines and report one error per field (the UI shows them next to the inputs).
import type { JsonValue } from "./types.ts";

export type ConfigFieldType = "string" | "number" | "boolean";

export type ConfigFieldSpec = {
  type: ConfigFieldType;
  /** Defaults to true. */
  required?: boolean;
};

export type ConfigSchema = Record<string, ConfigFieldSpec>;

export const CONFIG_FIELD_ERROR_CODES = [
  "required",
  "invalid_type",
  "unknown_field",
] as const;
export type ConfigFieldErrorCode = (typeof CONFIG_FIELD_ERROR_CODES)[number];

export type ConfigFieldError = {
  /** The offending key, or "$" when the config is not an object at all. */
  field: string;
  code: ConfigFieldErrorCode;
};

export type ConfigValidationResult =
  | { ok: true; config: { [key: string]: JsonValue } }
  | { ok: false; errors: ConfigFieldError[] };

/** Checks `input` against `schema`: required fields, field types, and no fields the schema lacks. */
export function validateConfigAgainstSchema(
  schema: ConfigSchema,
  input: unknown,
): ConfigValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return { ok: false, errors: [{ field: "$", code: "invalid_type" }] };

  const values = input as Record<string, unknown>;
  const errors: ConfigFieldError[] = [];
  const config: { [key: string]: JsonValue } = {};

  for (const [field, spec] of Object.entries(schema)) {
    const value = Object.hasOwn(values, field) ? values[field] : undefined;
    // An explicit null counts as "not given": it fails a required field and is left out of an
    // optional one, so a stored config never holds a null.
    if (value === undefined || value === null) {
      if (spec.required ?? true) errors.push({ field, code: "required" });
      continue;
    }
    // NaN and Infinity are numbers to typeof but turn into null in JSON, so they are not valid.
    const typeMatches =
      typeof value === spec.type &&
      (typeof value !== "number" || Number.isFinite(value));
    if (!typeMatches) {
      errors.push({ field, code: "invalid_type" });
      continue;
    }
    config[field] = value as string | number | boolean;
  }

  for (const field of Object.keys(values)) {
    if (!Object.hasOwn(schema, field))
      errors.push({ field, code: "unknown_field" });
  }

  return errors.length === 0 ? { ok: true, config } : { ok: false, errors };
}

// Best effort, a second line of defence: the per-type schema (known fields only) is the real
// protection. Matches key names such as privateKey, api_key, accessKey, client_secret, token,
// password, credential, authorization, jwt and pem; the SAFE pattern excludes names that merely
// mention one (access_tokens_url, tokenCount, token_id).
const SECRET_KEY_PATTERN =
  /private[_-]?key|secret|token|password|credential|api[_-]?key|access[_-]?key|authorization|jwt/i;
// Case sensitive, so that "development" is not mistaken for a PEM: pem, PEM, keyPem, private_pem.
const PEM_KEY_PATTERN = /(?:^|[_-])(?:pem|PEM)(?:$|[_-])|[a-z]Pem(?:[A-Z_-]|$)/;
const SAFE_KEY_SUFFIX_PATTERN = /(?:_url|Url|URL|_count|Count|_id|Id)$/;

function isSecretLikeKey(key: string): boolean {
  return (
    (SECRET_KEY_PATTERN.test(key) || PEM_KEY_PATTERN.test(key)) &&
    !SAFE_KEY_SUFFIX_PATTERN.test(key)
  );
}

/**
 * Paths of keys in `value` whose name suggests a secret. A config holds settings only: keys and
 * tokens belong to the `credentials` column (or, for the GitHub App, to the environment).
 */
export function findSecretLikeKeys(value: unknown, path = ""): string[] {
  if (typeof value !== "object" || value === null) return [];
  const found: string[] = [];
  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.map((item, index): [string, unknown] => [String(index), item])
    : Object.entries(value);
  for (const [key, child] of entries) {
    const childPath = path === "" ? key : `${path}.${key}`;
    if (!Array.isArray(value) && isSecretLikeKey(key)) found.push(childPath);
    found.push(...findSecretLikeKeys(child, childPath));
  }
  return found;
}
