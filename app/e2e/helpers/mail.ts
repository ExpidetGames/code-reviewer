// SPDX-License-Identifier: Apache-2.0

// The inbox of the sign-up journey. The app under test writes the mail it would send to a file, one JSON
// message per line (src/mail/outbox-sender.ts, switched on by the test stack only), and the journey reads
// the verification link from it the way a person reads it from their mailbox. The mail goes out after the
// answer to the request, so the journey waits for it.
import { existsSync, readFileSync } from "node:fs";
import { expect } from "@playwright/test";
import { e2eEnv } from "./e2e-env";

type Message = { to: string; subject: string; text: string };

export function readOutbox(file: string = e2eEnv.mailOutboxFile): Message[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Message);
}

/** The link in the newest mail to `address`, once there is one. */
export async function verificationLinkTo(address: string): Promise<string> {
  let link = "";
  await expect
    .poll(
      () => {
        const message = readOutbox()
          .filter((entry) => entry.to === address)
          .at(-1);
        link = /https?:\/\/\S+/.exec(message?.text ?? "")?.[0] ?? "";
        return link;
      },
      { message: `a mail with a link to ${address}` },
    )
    .not.toBe("");
  return link;
}

/** The links of the mails to `address`, oldest first, once there are `count` of them. */
export async function verificationLinksTo(
  address: string,
  count: number,
): Promise<string[]> {
  let links: string[] = [];
  await expect
    .poll(
      () => {
        links = readOutbox()
          .filter((entry) => entry.to === address)
          .map((entry) => /https?:\/\/\S+/.exec(entry.text)?.[0] ?? "")
          .filter((link) => link !== "");
        return links.length;
      },
      { message: `${String(count)} mails with a link to ${address}` },
    )
    .toBeGreaterThanOrEqual(count);
  return links;
}
