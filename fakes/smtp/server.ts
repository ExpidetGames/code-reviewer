// SPDX-License-Identifier: Apache-2.0

// A fake SMTP server (RFC 5321, the part a mail client uses), on loopback, for the tests of the app's mail
// sender and the browser journeys. It keeps every message it accepts, like a mailbox, so a test reads what
// was sent: the sender and recipients of the envelope, the raw text (to look for an injected header), and
// the parsed subject, text and HTML. It speaks the real protocol, so the production client code runs
// unchanged against it.
//
//   - one plain port that offers STARTTLS (and, with `startTls: false`, does not), one port with implicit
//     TLS (`tlsPort: null` leaves it out), both with a throwaway self-signed certificate (`cert.ts`);
//   - optional authentication (PLAIN and LOGIN) with one user and password, which may be demanded
//     before MAIL FROM and offered only after TLS (`authRequiresTls`);
//   - behaviors a test switches on: a connection that is accepted and never answered (`silent`), one that
//     is closed at once (`close`), and refusals of the sender, a recipient or the message.
//
// Dummy values only: nothing here is a real credential, and nothing leaves loopback.
import { randomUUID } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import { createSelfSignedCertificate, type FakeCertificate } from "./cert.ts";
import { parseMessage, type ParsedMessage } from "./mime.ts";

export type SmtpFakeBehavior = {
  /** `normal`; `silent`: accept the connection and never say a word; `close`: hang up at once. */
  greeting: "normal" | "silent" | "close";
  /** The text of a 550 answer to MAIL FROM, or null to accept the sender. */
  rejectSender: string | null;
  /** The text of a 550 answer to RCPT TO, or null to accept the recipient. */
  rejectRecipient: string | null;
  /** The text of a 554 answer after DATA, or null to accept the message. */
  rejectMessage: string | null;
  /** The text of the 535 answer to a wrong login. */
  authFailure: string;
};

export type SmtpFakeOptions = {
  host?: string;
  /** The plain port (STARTTLS is offered on it). Default: a free port. */
  port?: number;
  /** The port with implicit TLS; `null` for none. Default: a free port. */
  tlsPort?: number | null;
  /** Whether the plain port offers STARTTLS. Default true. */
  startTls?: boolean;
  /** The one login the server accepts; null: no authentication offered. */
  auth?: { user: string; password: string } | null;
  /** Offer authentication only on an encrypted connection. Default false. */
  authRequiresTls?: boolean;
  /** Refuse MAIL FROM until the client has logged in. Default: when `auth` is set. */
  requireAuth?: boolean;
};

export type SmtpSession = {
  /** Whether the connection was encrypted when it ended (implicit TLS, or after STARTTLS). */
  secure: boolean;
  /** The verbs the client sent, in order (the arguments are left out: they may hold a login). */
  commands: string[];
  /** The user the client logged in as, or null. */
  authenticatedAs: string | null;
};

export type CapturedMessage = ParsedMessage & {
  id: string;
  /** The address in MAIL FROM. */
  from: string;
  /** The addresses in RCPT TO. */
  to: string[];
  /** The message as it came over the wire (dot-unstuffed, lines ended by CRLF). */
  raw: string;
  secure: boolean;
  authenticatedAs: string | null;
};

export type SmtpFake = {
  host: string;
  port: number;
  tlsPort: number | null;
  /** The certificate the server presents; its public half can be handed to a client as `ca`. */
  certificate: string;
  messages: CapturedMessage[];
  sessions: SmtpSession[];
  behavior: SmtpFakeBehavior;
  /** The messages whose envelope has this recipient, oldest first. */
  to(address: string): CapturedMessage[];
  /** Forgets the messages and the sessions; the behavior and the login stay. */
  reset(): void;
  close(): Promise<void>;
};

const DEFAULT_BEHAVIOR: SmtpFakeBehavior = {
  greeting: "normal",
  rejectSender: null,
  rejectRecipient: null,
  rejectMessage: null,
  authFailure: "Authentication credentials invalid",
};

function listen(
  server: net.Server,
  host: string,
  port: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string")
        reject(new Error("The fake SMTP server has no port."));
      else resolve(address.port);
    });
  });
}

export async function startSmtpFake(
  options: SmtpFakeOptions = {},
): Promise<SmtpFake> {
  const host = options.host ?? "127.0.0.1";
  const certificate: FakeCertificate = createSelfSignedCertificate();
  const secureContext = tls.createSecureContext(certificate);
  const auth = options.auth ?? null;
  const requireAuth = options.requireAuth ?? auth !== null;
  const offerStartTls = options.startTls ?? true;

  const messages: CapturedMessage[] = [];
  const sessions: SmtpSession[] = [];
  const behavior: SmtpFakeBehavior = { ...DEFAULT_BEHAVIOR };
  const sockets = new Set<net.Socket>();

  function serve(initial: net.Socket, implicitTls: boolean): void {
    sockets.add(initial);
    initial.on("close", () => sockets.delete(initial));
    initial.on("error", () => undefined);
    const session: SmtpSession = {
      secure: implicitTls,
      commands: [],
      authenticatedAs: null,
    };
    sessions.push(session);
    if (behavior.greeting === "close") {
      initial.destroy();
      return;
    }

    let socket: net.Socket = initial;
    let buffer = "";
    let mode: "command" | "data" | "login-user" | "login-password" = "command";
    let loginUser = "";
    let envelope: { from: string; to: string[] } | null = null;

    const reply = (line: string) => {
      if (!socket.destroyed) socket.write(`${line}\r\n`);
    };

    function finishLogin(user: string, password: string): void {
      if (auth !== null && user === auth.user && password === auth.password) {
        session.authenticatedAs = user;
        reply("235 2.7.0 Authentication successful");
      } else reply(`535 5.7.8 ${behavior.authFailure}`);
    }

    function endOfData(data: string): void {
      const raw = data
        .split("\r\n")
        .map((line) => (line.startsWith(".") ? line.slice(1) : line))
        .join("\r\n");
      if (envelope === null) {
        reply("503 5.5.1 Need MAIL first");
        return;
      }
      if (behavior.rejectMessage !== null) {
        envelope = null;
        reply(`554 5.7.1 ${behavior.rejectMessage}`);
        return;
      }
      const id = randomUUID();
      messages.push({
        ...parseMessage(raw),
        id,
        from: envelope.from,
        to: envelope.to,
        raw,
        secure: session.secure,
        authenticatedAs: session.authenticatedAs,
      });
      envelope = null;
      reply(`250 2.0.0 Ok: queued as ${id}`);
    }

    function command(line: string): void {
      const verb = (line.split(" ")[0] ?? "").toUpperCase();
      session.commands.push(verb);
      switch (verb) {
        case "EHLO":
        case "HELO": {
          if (verb === "HELO") {
            reply("250 fake.smtp.test");
            return;
          }
          const lines = [
            "250-fake.smtp.test",
            "250-8BITMIME",
            "250-SIZE 10485760",
          ];
          if (offerStartTls && !session.secure) lines.push("250-STARTTLS");
          if (
            auth !== null &&
            (session.secure || options.authRequiresTls !== true)
          )
            lines.push("250-AUTH PLAIN LOGIN");
          // Every line but the last has a dash after the code.
          for (const entry of lines) reply(entry);
          reply("250 ENHANCEDSTATUSCODES");
          return;
        }
        case "STARTTLS": {
          if (!offerStartTls || session.secure) {
            reply("502 5.5.1 STARTTLS not available");
            return;
          }
          reply("220 2.0.0 Ready to start TLS");
          initial.removeAllListeners("data");
          const upgraded = new tls.TLSSocket(initial, {
            isServer: true,
            secureContext,
          });
          upgraded.on("error", () => undefined);
          socket = upgraded;
          session.secure = true;
          buffer = "";
          envelope = null;
          attach(upgraded);
          return;
        }
        case "AUTH": {
          if (
            auth === null ||
            (options.authRequiresTls === true && !session.secure)
          ) {
            reply("504 5.5.4 Authentication not available");
            return;
          }
          const [, mechanism = "", initialResponse] = line.split(" ");
          if (mechanism.toUpperCase() === "PLAIN") {
            if (initialResponse === undefined) {
              mode = "login-password";
              loginUser = "";
              reply("334 ");
              return;
            }
            const [, user = "", password = ""] = Buffer.from(
              initialResponse,
              "base64",
            )
              .toString("utf8")
              .split("\0");
            finishLogin(user, password);
            return;
          }
          if (mechanism.toUpperCase() === "LOGIN") {
            mode = "login-user";
            reply("334 VXNlcm5hbWU6");
            return;
          }
          reply("504 5.5.4 Unrecognized authentication type");
          return;
        }
        case "MAIL": {
          if (requireAuth && session.authenticatedAs === null) {
            reply("530 5.7.0 Authentication required");
            return;
          }
          const from = /^MAIL FROM:\s*<([^>]*)>/i.exec(line)?.[1];
          if (from === undefined) {
            reply("501 5.5.4 Syntax error in MAIL FROM");
            return;
          }
          if (behavior.rejectSender !== null) {
            reply(`550 5.7.1 ${behavior.rejectSender}`);
            return;
          }
          envelope = { from, to: [] };
          reply("250 2.1.0 Ok");
          return;
        }
        case "RCPT": {
          const to = /^RCPT TO:\s*<([^>]*)>/i.exec(line)?.[1];
          if (envelope === null || to === undefined) {
            reply("503 5.5.1 Need MAIL first");
            return;
          }
          if (behavior.rejectRecipient !== null) {
            reply(`550 5.1.1 ${behavior.rejectRecipient}`);
            return;
          }
          envelope.to.push(to);
          reply("250 2.1.5 Ok");
          return;
        }
        case "DATA": {
          if (envelope === null || envelope.to.length === 0) {
            reply("503 5.5.1 Need RCPT first");
            return;
          }
          mode = "data";
          reply("354 End data with <CR><LF>.<CR><LF>");
          return;
        }
        case "RSET":
          envelope = null;
          reply("250 2.0.0 Ok");
          return;
        case "NOOP":
          reply("250 2.0.0 Ok");
          return;
        case "QUIT":
          reply("221 2.0.0 Bye");
          socket.end();
          return;
        default:
          reply("502 5.5.2 Command not recognized");
      }
    }

    function drain(): void {
      for (;;) {
        if (mode === "data") {
          const terminator = buffer.startsWith(".\r\n")
            ? 0
            : buffer.indexOf("\r\n.\r\n");
          if (terminator === -1) return;
          const data = buffer.startsWith(".\r\n")
            ? ""
            : buffer.slice(0, terminator);
          buffer = buffer.slice(terminator === 0 ? 3 : terminator + 5);
          mode = "command";
          endOfData(data);
          continue;
        }
        const end = buffer.indexOf("\r\n");
        if (end === -1) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (mode === "login-user") {
          loginUser = Buffer.from(line, "base64").toString("utf8");
          mode = "login-password";
          reply("334 UGFzc3dvcmQ6");
        } else if (mode === "login-password") {
          mode = "command";
          // AUTH PLAIN without an initial response sends "\0user\0password"; LOGIN sends the password.
          const decoded = Buffer.from(line, "base64").toString("utf8");
          if (loginUser === "" && decoded.includes("\0")) {
            const [, user = "", password = ""] = decoded.split("\0");
            finishLogin(user, password);
          } else finishLogin(loginUser, decoded);
        } else command(line);
      }
    }

    function attach(target: net.Socket): void {
      target.setEncoding("utf8");
      target.on("data", (chunk: string) => {
        buffer += chunk;
        drain();
      });
      sockets.add(target);
      target.on("close", () => sockets.delete(target));
    }

    attach(initial);
    if (behavior.greeting === "silent") return;
    reply("220 fake.smtp.test ESMTP ready");
  }

  const plainServer = net.createServer((socket) => serve(socket, false));
  const port = await listen(plainServer, host, options.port ?? 0);
  let secureServer: tls.Server | null = null;
  let tlsPort: number | null = null;
  if (options.tlsPort !== null) {
    secureServer = tls.createServer(certificate, (socket) =>
      serve(socket, true),
    );
    tlsPort = await listen(secureServer, host, options.tlsPort ?? 0);
  }

  return {
    host,
    port,
    tlsPort,
    certificate: certificate.cert,
    messages,
    sessions,
    behavior,
    to: (address) => messages.filter((message) => message.to.includes(address)),
    reset() {
      messages.length = 0;
      sessions.length = 0;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        [plainServer, secureServer].map(
          (server) =>
            new Promise<void>((resolve) => {
              if (server === null) resolve();
              else server.close(() => resolve());
            }),
        ),
      );
    },
  };
}
