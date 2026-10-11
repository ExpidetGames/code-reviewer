// SPDX-License-Identifier: Apache-2.0

// A throwaway self-signed certificate for the fake SMTP server, made in memory every time the fake starts.
// Node can parse certificates but cannot make one, and committing a private key (even a dummy) is not
// allowed in this repository, so this writes the few bytes of the X.509 structure itself: an ECDSA P-256
// key, a certificate for `localhost` and 127.0.0.1 that is its own trust anchor (a test that wants a
// verified connection can hand it to the client as `ca`), valid for a day. The app under test refuses it
// by default, as it refuses any self-signed certificate, which is what the tests of the TLS errors need.
import { generateKeyPairSync, sign } from "node:crypto";

const SEQUENCE = 0x30;
const SET = 0x31;
const INTEGER = 0x02;
const BIT_STRING = 0x03;
const OCTET_STRING = 0x04;
const OBJECT_IDENTIFIER = 0x06;
const UTF8_STRING = 0x0c;
const UTC_TIME = 0x17;
const BOOLEAN = 0x01;

function lengthBytes(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256))
    bytes.unshift(rest % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), lengthBytes(body.length), body]);
}

const sequence = (...parts: Buffer[]) => der(SEQUENCE, ...parts);

function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes: number[] = [first * 40 + second];
  for (const arc of rest) {
    const chunk = [arc % 128];
    for (let value = Math.floor(arc / 128); value > 0; )
      (chunk.unshift((value % 128) | 0x80), (value = Math.floor(value / 128)));
    bytes.push(...chunk);
  }
  return der(OBJECT_IDENTIFIER, Buffer.from(bytes));
}

function integer(value: Buffer): Buffer {
  // A leading zero keeps a number with the high bit set from reading as negative.
  const body = (value[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.alloc(1), value]) : value;
  return der(INTEGER, body);
}

function utcTime(date: Date): Buffer {
  const pad = (value: number) => String(value).padStart(2, "0");
  const text =
    pad(date.getUTCFullYear() % 100) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "Z";
  return der(UTC_TIME, Buffer.from(text, "ascii"));
}

function commonName(name: string): Buffer {
  return sequence(
    der(SET, sequence(oid("2.5.4.3"), der(UTF8_STRING, Buffer.from(name)))),
  );
}

function pem(label: string, content: Buffer): string {
  const lines = content.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

export type FakeCertificate = { key: string; cert: string };

export function createSelfSignedCertificate(
  now: Date = new Date(),
): FakeCertificate {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const signatureAlgorithm = sequence(oid("1.2.840.10045.4.3.2")); // ecdsa-with-SHA256
  const name = commonName("localhost");
  const extensions = der(
    0xa3,
    sequence(
      // basicConstraints, critical: CA = true, so the certificate can be its own trust anchor.
      sequence(
        oid("2.5.29.19"),
        der(BOOLEAN, Buffer.from([0xff])),
        der(OCTET_STRING, sequence(der(BOOLEAN, Buffer.from([0xff])))),
      ),
      // subjectAltName: DNS localhost, IP 127.0.0.1.
      sequence(
        oid("2.5.29.17"),
        der(
          OCTET_STRING,
          sequence(
            der(0x82, Buffer.from("localhost", "ascii")),
            der(0x87, Buffer.from([127, 0, 0, 1])),
          ),
        ),
      ),
    ),
  );
  const toBeSigned = sequence(
    der(0xa0, integer(Buffer.from([2]))), // version 3
    integer(Buffer.from([1])),
    signatureAlgorithm,
    name,
    sequence(
      utcTime(new Date(now.getTime() - 60 * 60 * 1000)),
      utcTime(new Date(now.getTime() + 24 * 60 * 60 * 1000)),
    ),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    extensions,
  );
  const signature = sign("sha256", toBeSigned, {
    key: privateKey,
    dsaEncoding: "der",
  });
  const certificate = sequence(
    toBeSigned,
    signatureAlgorithm,
    der(BIT_STRING, Buffer.concat([Buffer.alloc(1), signature])),
  );
  return {
    key: privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    cert: pem("CERTIFICATE", certificate),
  };
}
