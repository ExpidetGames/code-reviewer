// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the encryption of credentials at rest: AES-256-GCM with a key per purpose, a fresh
// random nonce for every encryption, the key version stored with the value, and the table, row and
// field bound into the ciphertext so a copy to another place does not decrypt.
import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  SecretBoxError,
  type SecretLocation,
} from "./secret-box.ts";

const SECRET = "test-app-secret-0123456789-0123456789-abc";
const WHERE: SecretLocation = {
  table: "secrets",
  rowId: "smtp_password",
  field: "ciphertext",
};

function errorCodeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof SecretBoxError) return error.code;
    throw error;
  }
  throw new Error("did not throw");
}

describe("encryptSecret and decryptSecret", () => {
  // #97-SU-18
  it("decrypts what it encrypted, and stores a 96 bit nonce and the key version", () => {
    const sealed = encryptSecret(SECRET, WHERE, "correct horse battery staple");

    expect(sealed.keyVersion).toBe(1);
    expect(Buffer.from(sealed.nonce, "base64")).toHaveLength(12);
    expect(decryptSecret(SECRET, WHERE, sealed)).toBe(
      "correct horse battery staple",
    );
  });

  it("round-trips unicode and an empty value", () => {
    for (const value of ["", "pässwörd-✓-🔑"])
      expect(
        decryptSecret(SECRET, WHERE, encryptSecret(SECRET, WHERE, value)),
      ).toBe(value);
  });

  // #97-SU-18
  it("produces a different nonce and ciphertext when the same value is encrypted twice", () => {
    const first = encryptSecret(SECRET, WHERE, "same value");
    const second = encryptSecret(SECRET, WHERE, "same value");

    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("does not contain the plain value in what it stores", () => {
    const sealed = encryptSecret(SECRET, WHERE, "plain-value-visible");

    expect(JSON.stringify(sealed)).not.toContain("plain-value-visible");
    expect(
      Buffer.from(sealed.ciphertext, "base64").toString("latin1"),
    ).not.toContain("plain-value-visible");
  });

  // #97-SU-18
  it("fails when the ciphertext was changed", () => {
    const sealed = encryptSecret(SECRET, WHERE, "value");
    const bytes = Buffer.from(sealed.ciphertext, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 0x01;

    expect(
      errorCodeOf(() =>
        decryptSecret(SECRET, WHERE, {
          ...sealed,
          ciphertext: bytes.toString("base64"),
        }),
      ),
    ).toBe("secret_undecryptable");
  });

  it("fails when the nonce was changed or is not 96 bits", () => {
    const sealed = encryptSecret(SECRET, WHERE, "value");
    const other = encryptSecret(SECRET, WHERE, "value");

    expect(
      errorCodeOf(() =>
        decryptSecret(SECRET, WHERE, { ...sealed, nonce: other.nonce }),
      ),
    ).toBe("secret_undecryptable");
    expect(
      errorCodeOf(() =>
        decryptSecret(SECRET, WHERE, {
          ...sealed,
          nonce: Buffer.alloc(8).toString("base64"),
        }),
      ),
    ).toBe("secret_undecryptable");
  });

  // #97-SU-18
  it.each([
    ["another table", { ...WHERE, table: "integrations" }],
    ["another row", { ...WHERE, rowId: "github_private_key" }],
    ["another field", { ...WHERE, field: "other_field" }],
  ])("fails when the ciphertext is moved to %s", (_name, elsewhere) => {
    const sealed = encryptSecret(SECRET, WHERE, "value");

    expect(errorCodeOf(() => decryptSecret(SECRET, elsewhere, sealed))).toBe(
      "secret_undecryptable",
    );
  });

  // #97-SU-18
  it("cannot be decrypted with another secret", () => {
    const sealed = encryptSecret(SECRET, WHERE, "value");

    expect(errorCodeOf(() => decryptSecret(`${SECRET}x`, WHERE, sealed))).toBe(
      "secret_undecryptable",
    );
  });

  it("reports an unknown key version as its own error", () => {
    const sealed = encryptSecret(SECRET, WHERE, "value");

    expect(
      errorCodeOf(() =>
        decryptSecret(SECRET, WHERE, { ...sealed, keyVersion: 99 }),
      ),
    ).toBe("secret_key_version_unknown");
  });

  it("keeps the secret, the key and the value out of the error", () => {
    const sealed = encryptSecret(SECRET, WHERE, "very-secret-value");
    let message = "";
    try {
      decryptSecret(`${SECRET}x`, WHERE, sealed);
    } catch (error) {
      message = String(error instanceof Error ? error.message : error);
    }

    expect(message).not.toContain(SECRET);
    expect(message).not.toContain("very-secret-value");
    expect(message).not.toContain(sealed.ciphertext);
  });
});
