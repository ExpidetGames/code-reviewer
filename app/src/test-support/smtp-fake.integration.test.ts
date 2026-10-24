// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the fake SMTP server (fakes/smtp) over a real socket: the greeting and the capabilities, a
// delivery with its envelope, dot-stuffing and the parsing of an encoded message, STARTTLS and implicit
// TLS with the throwaway certificate, the login, and the behaviors a test switches on. The sender tests
// and the journeys rely on it, so a wrong fake fails here first.
import { X509Certificate } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import { describe, expect, it } from "vitest";
import { createSelfSignedCertificate } from "../../../fakes/smtp/cert.ts";
import { parseMessage } from "../../../fakes/smtp/mime.ts";
import {
  startTestSmtp,
  TEST_SMTP_PASSWORD,
  TEST_SMTP_USER,
} from "./smtp-fake.ts";

/** A client that sends lines and reads the replies, one line at a time. */
async function connect(port: number, secure = false) {
  const socket: net.Socket = secure
    ? tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false })
    : net.connect({ host: "127.0.0.1", port });
  socket.setEncoding("utf8");
  let buffer = "";
  const waiting: Array<() => void> = [];
  const onData = (chunk: string) => {
    buffer += chunk;
    for (const wake of waiting.splice(0)) wake();
  };
  socket.on("data", onData);
  socket.on("error", () => undefined);
  let current: net.Socket = socket;
  async function reply(): Promise<string[]> {
    for (;;) {
      const lines = buffer.split("\r\n");
      // A reply ends with a line whose fourth character is a space.
      const end = lines.findIndex((line) => /^\d{3} /.test(line));
      if (end !== -1) {
        buffer = lines.slice(end + 1).join("\r\n");
        return lines.slice(0, end + 1);
      }
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
  }
  return {
    reply,
    send: (line: string) => current.write(`${line}\r\n`),
    raw: (text: string) => current.write(text),
    async startTls() {
      socket.off("data", onData);
      const upgraded = tls.connect({ socket, rejectUnauthorized: false });
      upgraded.setEncoding("utf8");
      upgraded.on("data", onData);
      upgraded.on("error", () => undefined);
      current = upgraded;
    },
    end: () => current.destroy(),
  };
}

describe("the fake SMTP server", () => {
  it("makes a certificate that Node can read and that names localhost", () => {
    const { cert } = createSelfSignedCertificate();

    const parsed = new X509Certificate(cert);

    expect(parsed.subject).toBe("CN=localhost");
    expect(parsed.subjectAltName).toContain("DNS:localhost");
    expect(parsed.subjectAltName).toContain("IP Address:127.0.0.1");
    expect(parsed.ca).toBe(true);
    expect(parsed.verify(parsed.publicKey)).toBe(true);
  });

  it("greets, lists its capabilities and takes a message with its envelope", async () => {
    const smtp = await startTestSmtp({ tlsPort: null });
    const client = await connect(smtp.port);

    expect((await client.reply())[0]).toMatch(/^220 /);
    client.send("EHLO test");
    const capabilities = (await client.reply()).join("\n");
    expect(capabilities).toContain("STARTTLS");
    expect(capabilities).not.toContain("AUTH");
    client.send("MAIL FROM:<from@example.com>");
    expect((await client.reply())[0]).toMatch(/^250 /);
    client.send("RCPT TO:<one@example.com>");
    await client.reply();
    client.send("RCPT TO:<two@example.com>");
    await client.reply();
    client.send("DATA");
    expect((await client.reply())[0]).toMatch(/^354 /);
    client.raw(
      "Subject: =?UTF-8?B?SGVsbG8gd8O2cmxk?=\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nlink=3Dhttps://example.com/a?x=3D1=\r\n2\r\n..dotted\r\n.\r\n",
    );
    expect((await client.reply())[0]).toMatch(/^250 .*queued/);
    client.end();

    expect(smtp.messages).toHaveLength(1);
    const [message] = smtp.messages;
    expect(message?.from).toBe("from@example.com");
    expect(message?.to).toEqual(["one@example.com", "two@example.com"]);
    expect(message?.subject).toBe("Hello wörld");
    expect(message?.text).toBe("link=https://example.com/a?x=12\n.dotted");
    expect(smtp.to("two@example.com")).toHaveLength(1);
  });

  it("upgrades to TLS on STARTTLS and offers it only on the plain port", async () => {
    const smtp = await startTestSmtp();
    const client = await connect(smtp.port);
    await client.reply();
    client.send("EHLO test");
    await client.reply();

    client.send("STARTTLS");
    expect((await client.reply())[0]).toMatch(/^220 /);
    await client.startTls();
    client.send("EHLO test");
    const capabilities = (await client.reply()).join("\n");

    expect(capabilities).not.toContain("STARTTLS");
    expect(smtp.sessions.at(-1)?.secure).toBe(true);
    client.end();

    const implicit = await connect(smtp.tlsPort ?? 0, true);
    expect((await implicit.reply())[0]).toMatch(/^220 /);
    implicit.end();
  });

  it("logs in with PLAIN and LOGIN, refuses a wrong login, and demands one before MAIL", async () => {
    const smtp = await startTestSmtp({
      auth: { user: TEST_SMTP_USER, password: TEST_SMTP_PASSWORD },
      tlsPort: null,
    });
    const client = await connect(smtp.port);
    await client.reply();
    client.send("EHLO test");
    expect((await client.reply()).join("\n")).toContain("AUTH PLAIN LOGIN");

    client.send("MAIL FROM:<a@example.com>");
    expect((await client.reply())[0]).toMatch(/^530 /);

    const plain = (user: string, password: string) =>
      Buffer.from(`\0${user}\0${password}`).toString("base64");
    client.send(`AUTH PLAIN ${plain(TEST_SMTP_USER, "wrong")}`);
    expect((await client.reply())[0]).toMatch(/^535 /);
    client.send(`AUTH PLAIN ${plain(TEST_SMTP_USER, TEST_SMTP_PASSWORD)}`);
    expect((await client.reply())[0]).toMatch(/^235 /);
    expect(smtp.sessions.at(-1)?.authenticatedAs).toBe(TEST_SMTP_USER);
    client.end();

    const login = await connect(smtp.port);
    await login.reply();
    login.send("EHLO test");
    await login.reply();
    login.send("AUTH LOGIN");
    expect((await login.reply())[0]).toMatch(/^334 /);
    login.send(Buffer.from(TEST_SMTP_USER).toString("base64"));
    expect((await login.reply())[0]).toMatch(/^334 /);
    login.send(Buffer.from(TEST_SMTP_PASSWORD).toString("base64"));
    expect((await login.reply())[0]).toMatch(/^235 /);
    login.end();
  });

  it("keeps the commands of a session without their arguments", async () => {
    const smtp = await startTestSmtp({
      auth: { user: TEST_SMTP_USER, password: TEST_SMTP_PASSWORD },
      tlsPort: null,
    });
    const client = await connect(smtp.port);
    await client.reply();
    client.send("EHLO test");
    await client.reply();
    client.send(
      `AUTH PLAIN ${Buffer.from(`\0${TEST_SMTP_USER}\0${TEST_SMTP_PASSWORD}`).toString("base64")}`,
    );
    await client.reply();
    client.end();

    expect(smtp.sessions[0]?.commands).toEqual(["EHLO", "AUTH"]);
  });

  it("refuses the sender, a recipient or the message when told to", async () => {
    const smtp = await startTestSmtp({ tlsPort: null });
    smtp.behavior.rejectSender = "Sender not allowed";
    const client = await connect(smtp.port);
    await client.reply();
    client.send("EHLO test");
    await client.reply();
    client.send("MAIL FROM:<a@example.com>");
    expect((await client.reply())[0]).toBe("550 5.7.1 Sender not allowed");
    smtp.behavior.rejectSender = null;
    smtp.behavior.rejectRecipient = "No such user";
    client.send("MAIL FROM:<a@example.com>");
    await client.reply();
    client.send("RCPT TO:<b@example.com>");
    expect((await client.reply())[0]).toBe("550 5.1.1 No such user");
    client.end();
    expect(smtp.messages).toHaveLength(0);
  });

  it("accepts a connection and says nothing when told to, and hangs up when told to", async () => {
    const smtp = await startTestSmtp({ tlsPort: null });
    smtp.behavior.greeting = "silent";
    const silent = net.connect({ host: "127.0.0.1", port: smtp.port });
    silent.on("error", () => undefined);
    const heard: string[] = [];
    silent.on("data", (chunk) => heard.push(String(chunk)));
    await new Promise<void>((resolve) => silent.once("connect", resolve));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(heard).toEqual([]);
    silent.destroy();

    smtp.behavior.greeting = "close";
    const closed = net.connect({ host: "127.0.0.1", port: smtp.port });
    closed.on("error", () => undefined);
    await new Promise<void>((resolve) => closed.once("close", () => resolve()));
  });

  it("parses the headers and the parts of a multipart message", () => {
    const parsed = parseMessage(
      [
        "Subject: Hi",
        'Content-Type: multipart/alternative; boundary="b1"',
        "",
        "--b1",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from("plain part").toString("base64"),
        "--b1",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>html part</p>",
        "--b1--",
        "",
      ].join("\r\n"),
    );

    expect(parsed.text).toBe("plain part");
    expect(parsed.html.trim()).toBe("<p>html part</p>");
    expect(parsed.headers.subject).toEqual(["Hi"]);
  });
});
