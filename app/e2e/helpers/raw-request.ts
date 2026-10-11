// SPDX-License-Identifier: Apache-2.0

// An HTTP request that keeps what Playwright's request API hides: the header names exactly as the
// server wrote them (Playwright lower-cases them), as an observer sees them. The journeys that compare
// an answer with the answer of a path that does not exist need this: a header that Next.js writes as
// `Cache-Control` and the proxy as `cache-control` is an observable difference.
import { request } from "node:http";
import type { Page } from "@playwright/test";

export type RawAnswer = {
  status: number;
  /** "Name: value" for every header, the name as the server wrote it, sorted. */
  lines: string[];
  /** The headers by lower-case name (the last value, for one that came twice). */
  headers: Record<string, string>;
  body: string;
};

// Differ for every request, whatever the path.
const VOLATILE = new Set(["date"]);

/** The cookies of the page's browser context, as a `Cookie` header. */
async function cookieHeaderOf(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  return cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
}

export async function rawRequest(
  page: Page,
  baseUrl: string,
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<RawAnswer> {
  const url = new URL(path, baseUrl);
  const cookie = await cookieHeaderOf(page);
  const headers: Record<string, string> = {
    ...(cookie === "" ? {} : { cookie }),
    ...init.headers,
  };
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: url.hostname,
        port: url.port,
        // Not normalized: the path goes out exactly as it is written here.
        path: `${url.pathname}${url.search}`,
        method: init.method ?? "GET",
        headers,
        // One connection per request, so no answer depends on an earlier one.
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          const lines: string[] = [];
          const byName: Record<string, string> = {};
          for (let i = 0; i < response.rawHeaders.length; i += 2) {
            const name = response.rawHeaders[i] ?? "";
            const value = response.rawHeaders[i + 1] ?? "";
            if (VOLATILE.has(name.toLowerCase())) continue;
            lines.push(`${name}: ${value}`);
            byName[name.toLowerCase()] = value;
          }
          resolve({
            status: response.statusCode ?? 0,
            lines: lines.sort(),
            headers: byName,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end(init.body);
  });
}
