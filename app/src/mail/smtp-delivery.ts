// SPDX-License-Identifier: LicenseRef-Proprietary

// One delivery of one message to the configured mail server, with nodemailer. A single attempt (no queue,
// no retry): a transport is made for the message and closed afterwards, so nothing lingers between sends
// and a changed setting applies at once.
//
// The app connects to the host the admin entered, from its own network, on the port the admin entered
// (the admin is trusted; the ports below 1024 are limited to the mail ports in smtp-settings.ts). What
// follows from that is written here and in the README of this folder:
//
// - Encryption is never silently dropped. `starttls` demands the upgrade (`requireTLS`): a server that does
//   not offer STARTTLS is a `tls_error`, and neither the login nor the message is sent in the clear.
//   `tls` connects with TLS from the first byte. `none` is plain on purpose and does not even try STARTTLS.
// - The server's certificate is verified (TLS 1.2 or newer) unless the admin chose to allow self-signed
//   certificates, which turns the verification off completely.
// - Every wait has a time limit: connecting, the greeting, a silent socket, and the whole delivery.
// - A recipient, a subject and a name end up in a mail header. The recipient is checked against a strict
//   pattern, control characters are taken out of the subject and the name, the envelope is built from
//   exactly the addresses we mean, and the library encodes the rest. What it cannot do is tested
//   (smtp-delivery.integration.test.ts reads the bytes the server received).
// - The password is only ever in the transport options of the moment. No log line, no thrown error and no
//   result carries it (smtp-failure.ts cleans what a server quotes).
import { Socket } from "node:net";
import { createTransport } from "nodemailer";
import type { MailMessage } from "./sender.ts";
import { classifySmtpError, type SmtpFailure } from "./smtp-failure.ts";
import type { SmtpSettings } from "./smtp-settings.ts";

export type SmtpTimeouts = {
  /** Opening the TCP connection. */
  connectionMs: number;
  /** The server's first line after the connection is open. */
  greetingMs: number;
  /** A connection that says nothing for this long while we wait for it. */
  socketMs: number;
  /** The whole delivery, from the first connection attempt to the last reply. */
  totalMs: number;
};

export const DEFAULT_SMTP_TIMEOUTS: SmtpTimeouts = {
  connectionMs: 10_000,
  greetingMs: 10_000,
  socketMs: 20_000,
  totalMs: 30_000,
};

/** What a delivery needs: the settings and, if a login is configured, the password. */
export type SmtpConnection = {
  settings: SmtpSettings;
  password: string | null;
};

export type DeliveryResult = { ok: true } | { ok: false; failure: SmtpFailure };

// One address, nothing else: printable ASCII only, from an allow list of the characters of an unquoted address
// (letters, digits and the punctuation RFC 5322 allows in an atom, and dots and hyphens in the domain). No
// white space, no control character of any range, nothing that would make a header parser read a name, a
// comment, a group, a quoted string or a second address.
const PLAIN_ADDRESS = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9.-]+$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f\u2028\u2029]+/g;
const MAX_SUBJECT_LENGTH = 255;

/** Whether `address` is safe to put in a recipient header and an envelope. */
export function isDeliverableAddress(address: string): boolean {
  return address.length <= 254 && PLAIN_ADDRESS.test(address);
}

/** The subject with every control character (CR and LF above all) replaced by a space. */
export function safeSubject(subject: string): string {
  return subject
    .replaceAll(CONTROL_CHARACTERS, " ")
    .trim()
    .slice(0, MAX_SUBJECT_LENGTH);
}

function fromHeader(
  settings: SmtpSettings,
): string | { name: string; address: string } {
  if (settings.senderName === null) return settings.senderAddress;
  return {
    name: settings.senderName.replaceAll(CONTROL_CHARACTERS, " ").trim(),
    address: settings.senderAddress,
  };
}

export async function deliverOverSmtp(
  { settings, password }: SmtpConnection,
  message: MailMessage,
  timeouts: SmtpTimeouts = DEFAULT_SMTP_TIMEOUTS,
): Promise<DeliveryResult> {
  if (!isDeliverableAddress(message.to))
    return {
      ok: false,
      failure: {
        code: "invalid_message",
        detail: "The recipient address is not valid.",
      },
    };
  if (settings.user !== null && password === null)
    return { ok: false, failure: { code: "password_missing", detail: null } };
  // The stored settings cannot get here without it (smtp-settings.ts); this is the second line.
  if (
    settings.security === "none" &&
    settings.user !== null &&
    !settings.allowPlainTextLogin
  )
    return {
      ok: false,
      failure: {
        code: "unknown",
        detail:
          "Sending a login without encryption has not been confirmed in the settings.",
      },
    };

  // What must never come back in an answer: the password, and the forms in which the login travels.
  const secrets =
    password === null
      ? []
      : [
          password,
          ...(settings.user === null
            ? []
            : [
                `\0${settings.user}\0${password}`,
                `${settings.user}\0${password}`,
                `${settings.user}:${password}`,
              ]),
        ];
  // Our own socket, so that the deadline can destroy it. `close()` of a transport that is not pooled does
  // not close the connection of a send in progress, and a server that answers one byte at a time would
  // keep it open (and might still accept the message) long after the caller was told "timeout".
  const socket = new Socket();
  const transport = createTransport({
    socket,
    host: settings.host,
    port: settings.port,
    secure: settings.security === "tls",
    requireTLS: settings.security === "starttls",
    ignoreTLS: settings.security === "none",
    ...(settings.user === null || password === null
      ? {}
      : { auth: { user: settings.user, pass: password } }),
    tls: {
      rejectUnauthorized: !settings.allowSelfSigned,
      minVersion: "TLSv1.2",
    },
    connectionTimeout: timeouts.connectionMs,
    greetingTimeout: timeouts.greetingMs,
    socketTimeout: timeouts.socketMs,
    // Nothing in a message may make the library read a file or fetch an address.
    disableFileAccess: true,
    disableUrlAccess: true,
  });

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<DeliveryResult>((resolve) => {
    timer = setTimeout(() => {
      socket.destroy();
      transport.close();
      resolve({ ok: false, failure: { code: "timeout", detail: null } });
    }, timeouts.totalMs);
  });

  const delivery = (async (): Promise<DeliveryResult> => {
    try {
      const info = await transport.sendMail({
        from: fromHeader(settings),
        to: message.to,
        envelope: { from: settings.senderAddress, to: [message.to] },
        subject: safeSubject(message.subject),
        text: message.text,
        ...(message.html === undefined ? {} : { html: message.html }),
        // Tells auto-responders not to answer (RFC 3834).
        headers: { "Auto-Submitted": "auto-generated" },
      });
      if (info.accepted.length !== 1)
        return {
          ok: false,
          failure: { code: "recipient_rejected", detail: null },
        };
      return { ok: true };
    } catch (error) {
      return { ok: false, failure: classifySmtpError(error, secrets) };
    }
  })();

  try {
    return await Promise.race([delivery, deadline]);
  } finally {
    clearTimeout(timer);
    transport.close();
  }
}
