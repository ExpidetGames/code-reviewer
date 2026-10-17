// SPDX-License-Identifier: Apache-2.0

// Request body validation of the fake, against the shapes Paddle documents for the endpoints it implements
// (fakes/README.md). Strict on purpose: a field that is not in the shape is an error, so a client that drifts
// from the documented request fails against the fake before it fails against Paddle.
import { invalidFields, type FieldError } from "./errors.ts";

export type Check = (
  value: unknown,
  path: string,
  errors: FieldError[],
) => void;
export type Shape = Record<string, { check: Check; required: boolean }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fail = (errors: FieldError[], path: string, message: string) => {
  errors.push({ field: path, message });
};

/** Marks a field as optional (the default) or required. */
export const optional = (check: Check) => ({ check, required: false });
export const required = (check: Check) => ({ check, required: true });

export const string =
  (
    options: {
      min?: number;
      max?: number;
      pattern?: RegExp;
      oneOf?: readonly string[];
    } = {},
  ): Check =>
  (value, path, errors) => {
    if (typeof value !== "string")
      return fail(errors, path, "Must be a string");
    if (value.length < (options.min ?? 0))
      return fail(errors, path, `Must be at least ${options.min} characters`);
    if (value.length > (options.max ?? 10_000))
      return fail(errors, path, `Must be at most ${options.max} characters`);
    if (options.pattern !== undefined && !options.pattern.test(value))
      return fail(errors, path, "Has an invalid format");
    if (options.oneOf !== undefined && !options.oneOf.includes(value))
      return fail(errors, path, `Must be one of: ${options.oneOf.join(", ")}`);
  };

export const integer =
  (options: { min?: number; max?: number } = {}): Check =>
  (value, path, errors) => {
    if (typeof value !== "number" || !Number.isInteger(value))
      return fail(errors, path, "Must be an integer");
    if (value < (options.min ?? -Infinity))
      return fail(errors, path, `Must be at least ${options.min}`);
    if (value > (options.max ?? Infinity))
      return fail(errors, path, `Must be at most ${options.max}`);
  };

export const boolean: Check = (value, path, errors) => {
  if (typeof value !== "boolean") fail(errors, path, "Must be a boolean");
};

/** `custom_data`: any JSON object. */
export const record: Check = (value, path, errors) => {
  if (!isRecord(value)) fail(errors, path, "Must be an object");
};

export const nullable =
  (check: Check): Check =>
  (value, path, errors) => {
    if (value !== null) check(value, path, errors);
  };

export const array =
  (item: Check, options: { min?: number; max?: number } = {}): Check =>
  (value, path, errors) => {
    if (!Array.isArray(value)) return fail(errors, path, "Must be an array");
    if (value.length < (options.min ?? 0))
      return fail(errors, path, `Must have at least ${options.min} items`);
    if (value.length > (options.max ?? Infinity))
      return fail(errors, path, `Must have at most ${options.max} items`);
    value.forEach((entry, index) => item(entry, `${path}[${index}]`, errors));
  };

export const object =
  (shape: Shape): Check =>
  (value, path, errors) => {
    if (!isRecord(value)) return fail(errors, path, "Must be an object");
    checkShape(value, shape, errors, `${path}.`);
  };

function checkShape(
  body: Record<string, unknown>,
  shape: Shape,
  errors: FieldError[],
  prefix: string,
): void {
  for (const key of Object.keys(body))
    if (!(key in shape)) fail(errors, `${prefix}${key}`, "Unknown field");
  for (const [key, field] of Object.entries(shape)) {
    const present = key in body;
    if (!present) {
      if (field.required) fail(errors, `${prefix}${key}`, "Required");
      continue;
    }
    field.check(body[key], `${prefix}${key}`, errors);
  }
}

/** The body if it fits the shape; otherwise throws Paddle's 400 `invalid_field` with every problem listed. */
export function parseBody(
  body: unknown,
  shape: Shape,
): Record<string, unknown> {
  const errors: FieldError[] = [];
  if (body === undefined) body = {};
  if (!isRecord(body))
    throw invalidFields([
      { field: "", message: "The body must be a JSON object" },
    ]);
  checkShape(body, shape, errors, "");
  if (errors.length > 0) throw invalidFields(errors);
  return body;
}

export const MONEY: Shape = {
  amount: required(string({ pattern: /^\d{1,18}$/ })),
  currency_code: required(string({ pattern: /^[A-Z]{3}$/ })),
};

export const CYCLE: Shape = {
  interval: required(string({ oneOf: ["day", "week", "month", "year"] })),
  frequency: required(integer({ min: 1 })),
};
