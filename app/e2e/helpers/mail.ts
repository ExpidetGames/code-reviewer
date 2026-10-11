// SPDX-License-Identifier: Apache-2.0

// The inbox of the journeys. The app under test sends its mail over SMTP to the fake SMTP server
// (fakes/smtp), which the mail page's journey configures in the admin portal; the fake keeps every message and
// shows them through a small control API. A journey reads the link out of a message the way a person reads it
// from their mailbox. The mail goes out after the answer to the request, so the journeys wait for it.
import { expect } from "@playwright/test";
import { e2eEnv } from "./e2e-env";

export type InboxMessage = {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  secure: boolean;
  authenticatedAs: string | null;
};

/** Every message the fake SMTP server accepted, oldest first (only those to `address` when given). */
export async function readInbox(address?: string): Promise<InboxMessage[]> {
  const query =
    address === undefined ? "" : `?to=${encodeURIComponent(address)}`;
  const response = await fetch(
    `${e2eEnv.smtp.controlUrl}/__fake/messages${query}`,
  );
  if (!response.ok)
    throw new Error(
      `The fake SMTP server answered ${String(response.status)}.`,
    );
  return (await response.json()) as InboxMessage[];
}

function linkIn(message: InboxMessage | undefined): string {
  return /https?:\/\/\S+/.exec(message?.text ?? "")?.[0] ?? "";
}

/** The link in the newest mail to `address`, once there is one. */
export async function verificationLinkTo(address: string): Promise<string> {
  let link = "";
  await expect
    .poll(
      async () => {
        link = linkIn((await readInbox(address)).at(-1));
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
      async () => {
        links = (await readInbox(address))
          .map((message) => linkIn(message))
          .filter((link) => link !== "");
        return links.length;
      },
      { message: `${String(count)} mails with a link to ${address}` },
    )
    .toBeGreaterThanOrEqual(count);
  return links;
}

/** The newest message to `address` with this subject, once there is one. */
export async function messageTo(
  address: string,
  subject: string,
): Promise<InboxMessage> {
  let found: InboxMessage | undefined;
  await expect
    .poll(
      async () => {
        found = (await readInbox(address))
          .filter((message) => message.subject === subject)
          .at(-1);
        return found !== undefined;
      },
      { message: `a mail "${subject}" to ${address}` },
    )
    .toBe(true);
  if (found === undefined) throw new Error("unreachable");
  return found;
}
