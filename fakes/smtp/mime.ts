// SPDX-License-Identifier: Apache-2.0

// Reads a mail message the way a mailbox does, as far as the tests need: the headers (unfolded, names in
// lower case, every occurrence kept), the subject with encoded words decoded, and the plain text and the
// HTML part with their transfer encoding (quoted-printable, base64) removed. Not a general MIME parser:
// UTF-8 text and one level of multipart/alternative is what the app's mail library produces.

export type ParsedMessage = {
  /** Every header, by lower case name, in the order they appear. */
  headers: Record<string, string[]>;
  /** The header lines exactly as they were on the wire (folded lines joined with their break). */
  rawHeaderBlock: string;
  subject: string;
  text: string;
  html: string;
};

function splitHeadBody(raw: string): { head: string; body: string } {
  const normalized = raw.replaceAll("\r\n", "\n");
  const end = normalized.indexOf("\n\n");
  return end === -1
    ? { head: normalized, body: "" }
    : { head: normalized.slice(0, end), body: normalized.slice(end + 2) };
}

function parseHeaders(head: string): Record<string, string[]> {
  const unfolded: string[] = [];
  for (const line of head.split("\n")) {
    if (/^[ \t]/.test(line) && unfolded.length > 0)
      unfolded[unfolded.length - 1] += ` ${line.trim()}`;
    else unfolded.push(line);
  }
  const headers: Record<string, string[]> = {};
  for (const line of unfolded) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    (headers[name] ??= []).push(line.slice(colon + 1).trim());
  }
  return headers;
}

function decodeQuotedPrintable(text: string): Buffer {
  const joined = text.replaceAll(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let index = 0; index < joined.length; index += 1) {
    const char = joined[index] ?? "";
    const hex = joined.slice(index + 1, index + 3);
    if (char === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
    } else bytes.push(...Buffer.from(char, "utf8"));
  }
  return Buffer.from(bytes);
}

function decodeBody(body: string, encoding: string | undefined): string {
  switch (encoding?.trim().toLowerCase()) {
    case "quoted-printable":
      return decodeQuotedPrintable(body).toString("utf8");
    case "base64":
      return Buffer.from(body.replaceAll(/\s+/g, ""), "base64").toString(
        "utf8",
      );
    default:
      return body;
  }
}

/** Decodes `=?UTF-8?B?...?=` and `=?UTF-8?Q?...?=` words. */
export function decodeEncodedWords(value: string): string {
  return value
    .replaceAll(/\?=\s+=\?/g, "?==?")
    .replaceAll(
      /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
      (_match, _charset: string, kind: string, payload: string) =>
        kind.toLowerCase() === "b"
          ? Buffer.from(payload, "base64").toString("utf8")
          : decodeQuotedPrintable(payload.replaceAll("_", " ")).toString(
              "utf8",
            ),
    );
}

function boundaryOf(contentType: string): string | null {
  const match = /boundary="?([^";]+)"?/i.exec(contentType);
  return match?.[1] ?? null;
}

function collect(
  raw: string,
  found: { text: string; html: string },
  depth: number,
): void {
  const { head, body } = splitHeadBody(raw);
  const headers = parseHeaders(head);
  const contentType = (
    headers["content-type"]?.[0] ?? "text/plain"
  ).toLowerCase();
  const boundary = boundaryOf(headers["content-type"]?.[0] ?? "");
  if (contentType.startsWith("multipart/") && boundary !== null && depth < 4) {
    for (const part of body.split(`--${boundary}`).slice(1)) {
      if (part.startsWith("--")) break;
      collect(part.replace(/^\r?\n/, ""), found, depth + 1);
    }
    return;
  }
  const decoded = decodeBody(body, headers["content-transfer-encoding"]?.[0]);
  if (contentType.startsWith("text/html")) found.html ||= decoded;
  else if (contentType.startsWith("text/plain")) found.text ||= decoded;
}

export function parseMessage(raw: string): ParsedMessage {
  const { head } = splitHeadBody(raw);
  const headers = parseHeaders(head);
  const found = { text: "", html: "" };
  collect(raw, found, 0);
  return {
    headers,
    rawHeaderBlock: head,
    subject: decodeEncodedWords(headers.subject?.[0] ?? ""),
    text: found.text,
    html: found.html,
  };
}
