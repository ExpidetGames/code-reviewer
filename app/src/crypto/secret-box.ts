// Encryption of credentials at rest (docs/decisions/0001-editions-setup-and-accounts.md, section 2.7):
// AES-256-GCM with a key derived per purpose from the app secret, a random 96-bit nonce for every
// encryption, and the table, row and field as additional authenticated data, so a ciphertext copied
// to another row or field does not decrypt. The key version is stored with every secret so that a
// rotation of the secret can be added later without guessing which key made a value.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  CURRENT_KEY_VERSION,
  deriveKey,
  SUPPORTED_KEY_VERSIONS,
} from "./keys.ts";

export const SECRET_BOX_ERROR_CODES = [
  /** The value could not be decrypted: wrong secret, a changed value, or a different row or field. */
  "secret_undecryptable",
  /** The value was made with a key version this build does not know. */
  "secret_key_version_unknown",
] as const;
export type SecretBoxErrorCode = (typeof SECRET_BOX_ERROR_CODES)[number];

export class SecretBoxError extends Error {
  readonly code: SecretBoxErrorCode;

  // The message never contains a value, a key or the ciphertext.
  constructor(code: SecretBoxErrorCode) {
    super(
      code === "secret_undecryptable"
        ? "The stored secret cannot be decrypted (wrong APP_SECRET, or the value was changed)."
        : "The stored secret was made with an unknown key version.",
    );
    this.name = "SecretBoxError";
    this.code = code;
  }
}

/** Where a secret is stored. Bound into the ciphertext. */
export type SecretLocation = { table: string; rowId: string; field: string };

/** What is stored for a secret. All text, so it fits any column. */
export type SealedSecret = {
  keyVersion: number;
  /** 96 random bits, base64. */
  nonce: string;
  /** The encrypted value followed by the 128 bit authentication tag, base64. */
  ciphertext: string;
};

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const ALGORITHM = "aes-256-gcm";

// JSON keeps the three parts apart: no value of one part can be read as a piece of the next.
function additionalData(location: SecretLocation): Buffer {
  return Buffer.from(
    JSON.stringify([location.table, location.rowId, location.field]),
    "utf8",
  );
}

export function encryptSecret(
  appSecret: string,
  location: SecretLocation,
  plaintext: string,
): SealedSecret {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(
    ALGORITHM,
    deriveKey(appSecret, "secret-encryption", CURRENT_KEY_VERSION),
    nonce,
    { authTagLength: TAG_BYTES },
  );
  cipher.setAAD(additionalData(location));
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    keyVersion: CURRENT_KEY_VERSION,
    nonce: nonce.toString("base64"),
    ciphertext: encrypted.toString("base64"),
  };
}

export function decryptSecret(
  appSecret: string,
  location: SecretLocation,
  sealed: SealedSecret,
): string {
  if (!SUPPORTED_KEY_VERSIONS.includes(sealed.keyVersion))
    throw new SecretBoxError("secret_key_version_unknown");
  try {
    const nonce = Buffer.from(sealed.nonce, "base64");
    const data = Buffer.from(sealed.ciphertext, "base64");
    if (nonce.length !== NONCE_BYTES || data.length < TAG_BYTES)
      throw new Error("malformed");
    const decipher = createDecipheriv(
      ALGORITHM,
      deriveKey(appSecret, "secret-encryption", sealed.keyVersion),
      nonce,
      { authTagLength: TAG_BYTES },
    );
    decipher.setAAD(additionalData(location));
    decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
    return Buffer.concat([
      decipher.update(data.subarray(0, data.length - TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Whatever went wrong, the caller learns one thing, and nothing of the input.
    throw new SecretBoxError("secret_undecryptable");
  }
}
