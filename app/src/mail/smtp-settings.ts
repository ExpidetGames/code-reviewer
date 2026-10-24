// SPDX-License-Identifier: LicenseRef-Proprietary

// The settings of the instance's mail server (docs/decisions/0001-editions-setup-and-accounts.md, sections
// 2.3 and 2.7) and the rules for what the admin may enter. Pure functions: the store (smtp-config.ts) saves
// what passes here, the sender (smtp-sender.ts) uses it.
//
// Every field has its own stable code, and an issue never contains the value that caused it (a password
// must not end up in an answer or a log). A value that would end up in a mail header (the sender address
// and name, the user name of the login) refuses CR, LF and every other control character, so a setting can
// never inject a header.
import { isIP } from "node:net";
import type { SetupIssue } from "../setup/errors.ts";
import { isValidEmail } from "../setup/input.ts";

/** `starttls`: plain connection upgraded to TLS (usually port 587). `tls`: TLS from the start (465). `none`: unencrypted. */
export const SMTP_SECURITY_MODES = ["starttls", "tls", "none"] as const;
export type SmtpSecurity = (typeof SMTP_SECURITY_MODES)[number];

/** The non-secret settings, as they are stored (`instance_settings`, key `smtp`). */
export type SmtpSettings = {
  host: string;
  port: number;
  security: SmtpSecurity;
  /** The login of the mail server, or null for a server that needs none. */
  user: string | null;
  /** The address mail is sent from (the `From` header and the envelope sender). */
  senderAddress: string;
  /** The display name next to it, or null. */
  senderName: string | null;
  /**
   * Accept a certificate that is self-signed or not issued by a trusted authority, and one that does not
   * match the host. An explicit opt-in of the admin; always false without encryption.
   */
  allowSelfSigned: boolean;
  /**
   * The admin confirmed that the login (user and password) may be sent without encryption. Only ever true
   * for `none` with a login; without it such settings are refused.
   */
  allowPlainTextLogin: boolean;
};

export type SmtpPasswordChange =
  /** Leave the stored password as it is (the field was empty). */
  | { kind: "keep" }
  | { kind: "set"; value: string }
  /** Remove the stored password (the explicit clear). */
  | { kind: "clear" };

export type SmtpInput = {
  settings: SmtpSettings;
  password: SmtpPasswordChange;
};

export const SMTP_ISSUE_CODES = [
  /** The body is not an object. */
  "smtp_invalid",
  "host_required",
  "host_invalid",
  "port_invalid",
  /** A port below 1024 that is not one of the three mail ports (25, 465, 587). */
  "port_not_allowed",
  "security_invalid",
  "user_invalid",
  "password_invalid",
  "password_too_long",
  /** A new password and the clear flag in one request. */
  "password_conflict",
  /** A login user is set and there is no password to log in with. */
  "password_required",
  /** A password for a server that needs no login. */
  "user_required",
  "clear_password_invalid",
  "sender_required",
  "sender_invalid",
  "sender_name_invalid",
  "allow_self_signed_invalid",
  "allow_plain_text_login_invalid",
  /** `none` with a login, and the admin did not confirm that the password goes out in the clear. */
  "plain_text_login_not_confirmed",
  /** Host, port, user or security changed: the saved password is not carried over to a new server. */
  "password_required_for_new_server",
] as const;
export type SmtpIssueCode = (typeof SMTP_ISSUE_CODES)[number];

/** Below 1024 only the three ports of mail are allowed; the app connects to this host from its own network. */
export const MAIL_PORTS_BELOW_1024: readonly number[] = [25, 465, 587];
export const SMTP_PASSWORD_MAX_LENGTH = 1024;
export const SMTP_USER_MAX_LENGTH = 255;
export const SMTP_SENDER_NAME_MAX_LENGTH = 100;

// C0 controls (CR and LF among them), DEL, and the Unicode line and paragraph separators.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f\u2028\u2029]/;
const HOST_LABEL = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An IP address, or a host name of labels of letters, digits, hyphens and underscores. */
export function isValidSmtpHost(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  if (isIP(host) !== 0) return true;
  return host.split(".").every((label) => HOST_LABEL.test(label));
}

function parseOptionalText(
  raw: unknown,
  maxLength: number,
): string | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (text === "") return null;
  if (text.length > maxLength || CONTROL_CHARACTER.test(text)) return undefined;
  return text;
}

export type ParseSmtpResult =
  { ok: true; value: SmtpInput } | { ok: false; issues: SetupIssue[] };

export function parseSmtpInput(raw: unknown): ParseSmtpResult {
  if (!isObject(raw))
    return { ok: false, issues: [{ field: "smtp", code: "smtp_invalid" }] };
  const issues: SetupIssue[] = [];
  const refuse = (field: string, code: SmtpIssueCode) =>
    issues.push({ field, code });

  const hostText =
    typeof raw.host === "string" ? raw.host.trim().toLowerCase() : "";
  if (hostText === "") refuse("host", "host_required");
  else if (!isValidSmtpHost(hostText)) refuse("host", "host_invalid");

  const port = raw.port;
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    refuse("port", "port_invalid");
  else if (port < 1024 && !MAIL_PORTS_BELOW_1024.includes(port))
    refuse("port", "port_not_allowed");

  const security = SMTP_SECURITY_MODES.find((mode) => mode === raw.security);
  if (security === undefined) refuse("security", "security_invalid");

  const user = parseOptionalText(raw.user, SMTP_USER_MAX_LENGTH);
  if (user === undefined) refuse("user", "user_invalid");

  const senderText =
    typeof raw.senderAddress === "string" ? raw.senderAddress.trim() : "";
  if (senderText === "") refuse("senderAddress", "sender_required");
  else if (CONTROL_CHARACTER.test(senderText) || !isValidEmail(senderText))
    refuse("senderAddress", "sender_invalid");

  const senderName = parseOptionalText(
    raw.senderName,
    SMTP_SENDER_NAME_MAX_LENGTH,
  );
  if (senderName === undefined) refuse("senderName", "sender_name_invalid");

  const allowSelfSigned = raw.allowSelfSigned ?? false;
  if (typeof allowSelfSigned !== "boolean")
    refuse("allowSelfSigned", "allow_self_signed_invalid");

  const allowPlainTextLogin = raw.allowPlainTextLogin ?? false;
  if (typeof allowPlainTextLogin !== "boolean")
    refuse("allowPlainTextLogin", "allow_plain_text_login_invalid");
  else if (
    security === "none" &&
    user !== undefined &&
    user !== null &&
    !allowPlainTextLogin
  )
    refuse("allowPlainTextLogin", "plain_text_login_not_confirmed");

  const clear = raw.clearPassword ?? false;
  if (typeof clear !== "boolean")
    refuse("clearPassword", "clear_password_invalid");

  let password: SmtpPasswordChange = { kind: "keep" };
  if (raw.password !== undefined && raw.password !== null) {
    if (typeof raw.password !== "string")
      refuse("password", "password_invalid");
    else if (raw.password.length > SMTP_PASSWORD_MAX_LENGTH)
      refuse("password", "password_too_long");
    else if (/[\r\n\0]/.test(raw.password))
      refuse("password", "password_invalid");
    else if (raw.password !== "") {
      if (clear === true) refuse("password", "password_conflict");
      password = { kind: "set", value: raw.password };
    }
  }
  if (clear === true && password.kind === "keep") password = { kind: "clear" };

  if (
    issues.length > 0 ||
    security === undefined ||
    user === undefined ||
    senderName === undefined ||
    typeof port !== "number" ||
    typeof allowSelfSigned !== "boolean" ||
    typeof allowPlainTextLogin !== "boolean"
  )
    return { ok: false, issues };

  return {
    ok: true,
    value: {
      settings: {
        host: hostText,
        port,
        security,
        user,
        senderAddress: senderText,
        senderName,
        // Without encryption there is no certificate to accept.
        allowSelfSigned: security === "none" ? false : allowSelfSigned,
        allowPlainTextLogin:
          security === "none" && user !== null && allowPlainTextLogin,
      },
      password,
    },
  };
}

/**
 * Whether stored JSON is a complete, valid set of settings (a row edited by hand, or written by a later
 * version, must not make the sender connect to something the validation would have refused).
 */
export function readStoredSmtpSettings(raw: unknown): SmtpSettings | null {
  const parsed = parseSmtpInput(raw);
  return parsed.ok ? parsed.value.settings : null;
}
