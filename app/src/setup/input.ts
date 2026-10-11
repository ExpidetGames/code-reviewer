// SPDX-License-Identifier: Apache-2.0

// Validation of what the wizard sends: the tenancy, the sign-up rule with its entries, and the admin
// account. The server is the only judge (the form shows the reasons it gets back). Problems are
// reported per field with a stable code and never contain the value: a password must not end up in
// an answer or a log.
import { z } from "zod";
import { checkPassword } from "../auth/password-policy.ts";
import type { InstanceSettingValues } from "../db/repositories/instance-settings-repository.ts";
import type { SetupIssue } from "./errors.ts";

export type Tenancy = InstanceSettingValues["tenancy"];
export type SignUpRule = InstanceSettingValues["sign_up_rule"];

export type SetupInput = {
  tenancy: Tenancy;
  signUp: SignUpRule;
  admin: { email: string; password: string };
};

export const MAX_RULE_ENTRIES = 500;
const MAX_EMAIL_LENGTH = 254;

// The very rule Better Auth applies to the email address of every sign in (`z.email()` of the zod it
// uses, the same version, pinned in package.json; email-agreement.integration.test.ts proves they agree), not a looser look-alike: an address the setup accepts but the sign in rejects would
// make an admin who can never sign in, on an instance whose setup is over. Whether the address really
// exists is for the mail verification (a later issue) to find out.
const emailSchema = z.email();
// ASCII domain names only (internationalized ones are written in their xn-- form).
const DOMAIN =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidEmail(value: string): boolean {
  return (
    value.length <= MAX_EMAIL_LENGTH && emailSchema.safeParse(value).success
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntries(
  raw: unknown,
  valid: (entry: string) => boolean,
  normalize: (entry: string) => string,
  issues: SetupIssue[],
): string[] {
  const field = "signUp.entries";
  if (!Array.isArray(raw)) {
    issues.push({ field, code: "entries_required" });
    return [];
  }
  if (raw.length > MAX_RULE_ENTRIES) {
    issues.push({ field, code: "too_many_entries" });
    return [];
  }
  const entries: string[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== "string") {
      issues.push({ field, code: "entry_invalid" });
      return [];
    }
    const entry = normalize(item);
    if (entry === "") continue;
    if (!valid(entry)) {
      issues.push({ field, code: "entry_invalid" });
      return [];
    }
    if (!entries.includes(entry)) entries.push(entry);
  }
  if (entries.length === 0) issues.push({ field, code: "entries_required" });
  return entries;
}

function parseSignUp(raw: unknown, issues: SetupIssue[]): SignUpRule | null {
  if (!isObject(raw)) {
    issues.push({ field: "signUp", code: "sign_up_rule_invalid" });
    return null;
  }
  switch (raw.kind) {
    case "everyone":
      return { kind: "everyone" };
    case "emails": {
      const entries = parseEntries(
        raw.entries,
        isValidEmail,
        normalizeEmail,
        issues,
      );
      return entries.length === 0 ? null : { kind: "emails", entries };
    }
    case "domains": {
      const entries = parseEntries(
        raw.entries,
        (entry) => DOMAIN.test(entry),
        // An entry may be written `@example.com`; it matches exactly that domain, not its subdomains.
        (entry) => entry.trim().toLowerCase().replace(/^@/, ""),
        issues,
      );
      return entries.length === 0 ? null : { kind: "domains", entries };
    }
    default:
      issues.push({ field: "signUp.kind", code: "sign_up_rule_invalid" });
      return null;
  }
}

export type ParsedSetupInput =
  { ok: true; input: SetupInput } | { ok: false; issues: SetupIssue[] };

export function parseSetupInput(body: unknown): ParsedSetupInput {
  const issues: SetupIssue[] = [];
  if (!isObject(body))
    return { ok: false, issues: [{ field: "", code: "body_invalid" }] };

  const tenancy = body.tenancy;
  if (tenancy !== "single" && tenancy !== "multi")
    issues.push({ field: "tenancy", code: "tenancy_invalid" });

  const signUp = parseSignUp(body.signUp, issues);

  let email = "";
  let password = "";
  const admin = body.admin;
  if (!isObject(admin)) {
    issues.push({ field: "admin", code: "admin_invalid" });
  } else {
    if (
      typeof admin.email !== "string" ||
      !isValidEmail(normalizeEmail(admin.email))
    )
      issues.push({ field: "admin.email", code: "email_invalid" });
    else email = normalizeEmail(admin.email);
    if (typeof admin.password !== "string")
      issues.push({ field: "admin.password", code: "password_too_short" });
    else {
      const check = checkPassword(admin.password);
      if (!check.ok) issues.push({ field: "admin.password", code: check.code });
      else password = admin.password;
    }
  }

  if (
    issues.length > 0 ||
    signUp === null ||
    (tenancy !== "single" && tenancy !== "multi")
  )
    return { ok: false, issues };
  return { ok: true, input: { tenancy, signUp, admin: { email, password } } };
}
