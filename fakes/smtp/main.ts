// SPDX-License-Identifier: Apache-2.0

// Starts the fake SMTP server as its own process, for the Playwright journeys: the app under test is
// configured in the admin portal to send to it, and the journey reads the "inbox" from a small HTTP
// control API next to it. Configuration comes from the environment; the values are dummies shared with
// the journeys.
//
//   SMTP_FAKE_PORT          plain port, STARTTLS offered (required)
//   SMTP_FAKE_TLS_PORT      port with implicit TLS (required)
//   SMTP_FAKE_CONTROL_PORT  the control API (required)
//   SMTP_FAKE_USER          the login the server accepts; with SMTP_FAKE_PASSWORD, switches authentication on
//   SMTP_FAKE_PASSWORD
//   SMTP_FAKE_HOST          default 127.0.0.1
//
// Control API (JSON, no authentication: loopback and test only):
//   GET  /__fake/health                      200 once the server is up
//   GET  /__fake/messages[?to=<address>]     the accepted messages, oldest first
//   POST /__fake/reset                       forgets the messages and sessions
import { createServer } from "node:http";
import { startSmtpFake } from "./server.ts";

function requiredPort(name: string): number {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    console.error(`${name} must be set to a port number.`);
    process.exit(1);
  }
  return value;
}

const host = process.env.SMTP_FAKE_HOST || "127.0.0.1";
const user = process.env.SMTP_FAKE_USER;
const password = process.env.SMTP_FAKE_PASSWORD;
if ((user === undefined) !== (password === undefined)) {
  console.error("SMTP_FAKE_USER and SMTP_FAKE_PASSWORD must be set together.");
  process.exit(1);
}

const fake = await startSmtpFake({
  host,
  port: requiredPort("SMTP_FAKE_PORT"),
  tlsPort: requiredPort("SMTP_FAKE_TLS_PORT"),
  auth:
    user === undefined || password === undefined ? null : { user, password },
});

const control = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const send = (status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  if (url.pathname === "/__fake/health" && request.method === "GET")
    return send(200, { ok: true });
  if (url.pathname === "/__fake/messages" && request.method === "GET") {
    const to = url.searchParams.get("to");
    const found = to === null ? fake.messages : fake.to(to);
    return send(
      200,
      found.map((message) => ({
        from: message.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        secure: message.secure,
        authenticatedAs: message.authenticatedAs,
      })),
    );
  }
  if (url.pathname === "/__fake/reset" && request.method === "POST") {
    fake.reset();
    return send(200, { ok: true });
  }
  return send(404, { error: "not_found" });
});
await new Promise<void>((resolve) =>
  control.listen(requiredPort("SMTP_FAKE_CONTROL_PORT"), host, resolve),
);
console.info(
  `fake smtp listening on ${host}:${String(fake.port)} (STARTTLS), ${host}:${String(fake.tlsPort)} (TLS); control on ${host}:${process.env.SMTP_FAKE_CONTROL_PORT ?? ""}`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    control.close();
    void fake.close().finally(() => process.exit(0));
  });
}
