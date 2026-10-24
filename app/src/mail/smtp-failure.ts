// SPDX-License-Identifier: LicenseRef-Proprietary

// What went wrong with a mail server, as a stable code and a sentence that is safe to show the admin
// (the test mail button, docs/decisions/0001-editions-setup-and-accounts.md, section 2.3). The mail
// library reports a failure as an error with a `code`, a `command` and the server's reply; this sorts it
// into the classes below and cleans whatever is quoted.
//
// Nothing the library says is passed on as it is. Its message can name the host or an address, a server's
// reply can repeat what the client sent (a login), and a hostile server can write anything. So the detail
// is either our own sentence (certificate problems) or the first line of the server's reply, as printable
// text, without the password in any spelling, without long opaque tokens, and cut short.
export const SMTP_FAILURE_CODES = [
  /** The host name does not resolve. */
  "dns_failure",
  /** Nothing listens on that host and port (or a firewall refuses). */
  "connection_refused",
  /** The secure connection failed: certificate, protocol, or no TLS where it was demanded. */
  "tls_error",
  /** The server refused the login. */
  "auth_failed",
  /** The server refused the sender address. */
  "sender_rejected",
  /** The server refused the recipient. */
  "recipient_rejected",
  /** The server did not answer in time. */
  "timeout",
  /** The message was refused before it was sent (an address that is not one). */
  "invalid_message",
  /** A login is configured and there is no password to log in with. */
  "password_missing",
  /** The stored password cannot be decrypted (another APP_SECRET): it must be entered again. */
  "password_unreadable",
  "unknown",
] as const;
export type SmtpFailureCode = (typeof SMTP_FAILURE_CODES)[number];

export type SmtpFailure = {
  code: SmtpFailureCode;
  /** A sentence or a cleaned server reply to show next to the code, or null. */
  detail: string | null;
};

const MAX_DETAIL_LENGTH = 200;
// A run of base64 or hex characters this long is not a word of a sentence; a server that echoes a login
// would echo it like this.
const OPAQUE_TOKEN = /[A-Za-z0-9+/=_-]{24,}/g;

function percentEncodedBytes(buffer: Buffer): string {
  return [...buffer]
    .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
    .join("");
}

// Every spelling in which a server could repeat a secret. Matching is case-insensitive (upper-case hex,
// lower-case percent escapes), which over-redacts a little base64 and never under-redacts.
function encodings(secret: string): string[] {
  const buffer = Buffer.from(secret, "utf8");
  const base64 = buffer.toString("base64");
  return [
    secret,
    base64,
    base64.replace(/=+$/, ""),
    buffer.toString("base64url"),
    buffer.toString("hex"),
    encodeURIComponent(secret),
    percentEncodedBytes(buffer),
  ];
}

function escapeForPattern(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The secrets to keep out of a text, in every spelling. Give it the password and, for a login, the forms in
 * which a login travels: `\0user\0password` (AUTH PLAIN, base64 encoded on the wire) and `user\0password`.
 * AUTH LOGIN sends the user and the password one after the other, which the password's own spellings cover.
 */
export function secretPattern(secrets: readonly string[]): RegExp | null {
  const spellings = [
    ...new Set(secrets.filter((secret) => secret !== "").flatMap(encodings)),
  ].sort((a, b) => b.length - a.length);
  if (spellings.length === 0) return null;
  return new RegExp(spellings.map(escapeForPattern).join("|"), "gi");
}

/** The first line of a server's reply, safe to show: see the header of this file. */
export function sanitizeServerMessage(
  text: unknown,
  secrets: readonly string[],
): string | null {
  if (typeof text !== "string") return null;
  let line = text.split(/\r?\n/)[0] ?? "";
  const pattern = secretPattern(secrets);
  if (pattern !== null) line = line.replace(pattern, "[secret]");
  line = line
    .replaceAll(OPAQUE_TOKEN, "[redacted]")
    .replaceAll(/[^\x20-\x7e]+/g, "?")
    .replaceAll(/\s+/g, " ")
    .trim();
  if (line === "") return null;
  return line.slice(0, MAX_DETAIL_LENGTH);
}

function certificateHint(message: string): string {
  if (/self[- ]signed/i.test(message))
    return "The server's certificate is self-signed. Use a certificate from a trusted authority, or allow self-signed certificates in these settings.";
  if (/expired/i.test(message)) return "The server's certificate has expired.";
  if (/altnames|does not match|hostname/i.test(message))
    return "The server's certificate is not valid for this host name.";
  if (/unable to (verify|get)|issuer|untrusted|not trusted/i.test(message))
    return "The server's certificate was not issued by an authority this server trusts.";
  if (
    /wrong version number|record_header|ssl routines|packet length/i.test(
      message,
    )
  )
    return "The server did not answer with TLS on this port. Check the port and the security mode (usually port 465 is TLS and port 587 is STARTTLS).";
  return "The secure connection could not be set up.";
}

function field(error: unknown, name: string): string {
  if (typeof error !== "object" || error === null) return "";
  const value = (error as Record<string, unknown>)[name];
  return typeof value === "string" ? value : "";
}

/** Sorts an error of the mail library. `secrets` are the values that must not appear in the detail. */
export function classifySmtpError(
  error: unknown,
  secrets: readonly string[],
): SmtpFailure {
  const code = field(error, "code");
  const command = field(error, "command");
  const message = field(error, "message");
  const reply = sanitizeServerMessage(field(error, "response"), secrets);

  switch (code) {
    case "EDNS":
      return { code: "dns_failure", detail: null };
    case "EAUTH":
      return { code: "auth_failed", detail: reply };
    case "ETLS":
      return {
        code: "tls_error",
        detail: /STARTTLS/i.test(command)
          ? "The server does not offer STARTTLS. Choose another security mode, or a server that supports it."
          : certificateHint(message),
      };
    case "EENVELOPE":
      return /MAIL/i.test(command)
        ? { code: "sender_rejected", detail: reply }
        : { code: "recipient_rejected", detail: reply };
    case "ETIMEDOUT":
    case "ETIMEOUT":
      return { code: "timeout", detail: null };
    default:
      break;
  }

  if (/ENOTFOUND|EAI_AGAIN|EAI_NODATA|getaddrinfo/i.test(message))
    return { code: "dns_failure", detail: null };
  if (/ECONNREFUSED/i.test(message))
    return { code: "connection_refused", detail: null };
  if (
    /certificate|ssl|tls|handshake|wrong version number|altnames|self[- ]signed|unable to verify/i.test(
      message,
    )
  )
    return { code: "tls_error", detail: certificateHint(message) };
  if (/timed out|timeout/i.test(message))
    return { code: "timeout", detail: null };
  return { code: "unknown", detail: reply };
}
