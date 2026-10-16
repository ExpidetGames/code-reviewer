// SPDX-License-Identifier: Apache-2.0

// What the hosted lane (#332) knows that no log, page or record may hold, besides the dummies of the environment: the
// per-job credentials (the stand-in keeps a copy of every start document, `docker-worker.sh`, `E2E_STDIN_COPY_DIR`), the
// session cookies of the admin and the setup code. They are kept in a directory of their own, which no scan reads, and
// the scans search every log for what is in it.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { hostedEnv } from "./hosted-env";

const directory = () => resolve(process.cwd(), hostedEnv.secretsDirectory);

/** Remembers a value the logs must not hold (a session cookie, a setup code), with its URL-decoded form. */
export function rememberSecret(name: string, value: string): void {
  mkdirSync(directory(), { recursive: true });
  const forms = new Set([value, decodeURIComponent(value)]);
  for (const form of forms)
    if (form !== "")
      appendFileSync(join(directory(), `${name}.txt`), `${form}\n`);
}

/** The start documents the Worker was given so far: the per-job credentials among them. */
export function perJobCredentials(): string[] {
  if (!existsSync(directory())) return [];
  return readdirSync(directory())
    .filter((file) => /^run-\d+\.stdin$/.test(file))
    .map((file) => {
      const document = JSON.parse(
        readFileSync(join(directory(), file), "utf8"),
      ) as {
        credential?: unknown;
      };
      if (typeof document.credential !== "string" || document.credential === "")
        throw new Error(`The start document ${file} holds no credential.`);
      return document.credential;
    });
}

/** The session cookies and the setup codes remembered so far. */
export function rememberedSecrets(): string[] {
  if (!existsSync(directory())) return [];
  return readdirSync(directory())
    .filter((file) => file.endsWith(".txt"))
    .flatMap((file) =>
      readFileSync(join(directory(), file), "utf8")
        .split("\n")
        .filter((line) => line !== ""),
    );
}

/** Everything the lane knows that must be nowhere: the dummies, the per-job credentials, the cookies, the setup codes. */
export function allSecrets(): string[] {
  return [...new Set([...perJobCredentials(), ...rememberedSecrets()])];
}

/**
 * Whether the text holds the secret. A setup code is six digits, which a log holds by chance (a port, a duration, a
 * process id): it counts when it stands next to the word "code", as a code is ever printed. Everything else counts
 * wherever it is.
 */
export function containsSecret(text: string, secret: string): boolean {
  if (!/^\d{6}$/.test(secret)) return text.includes(secret);
  return new RegExp(`code\\W{1,8}${secret}(?!\\d)`, "i").test(text);
}
