// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  DISPATCH_TIMEOUT_MS,
  parseRetryAfter,
  sendDispatch,
  type DispatchFetch,
} from "./send.ts";
import type { DispatchRequest } from "./request.ts";

const SECRET = "dispatch-signing-secret-0123456789abcdef";
const SIGNATURE = `v1=${"ab".repeat(32)}`;
const NOW = new Date("2026-10-10T12:00:00.000Z");
const URL_OK = "https://dispatcher.example.test/dispatch";

const request: DispatchRequest = {
  body: '{"version":1}',
  headers: {
    "content-type": "application/json",
    "x-dispatch-signature": SIGNATURE,
  },
};

function answering(response: Response): {
  fetch: DispatchFetch;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(response);
    },
  };
}

const send = (fetch: DispatchFetch, timeoutMs = DISPATCH_TIMEOUT_MS) =>
  sendDispatch({ url: URL_OK, request, fetch, timeoutMs, now: () => NOW });

describe("sending the dispatch request", () => {
  // #326-T01
  it("posts the signed body once, with an 8 second timeout, without following redirects", async () => {
    const { fetch, calls } = answering(new Response(null, { status: 202 }));

    expect(await send(fetch)).toEqual({ kind: "accepted" });

    expect(DISPATCH_TIMEOUT_MS).toBe(8000);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(URL_OK);
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(request.body);
    expect(calls[0]?.init.headers).toEqual(request.headers);
    expect(calls[0]?.init.redirect).toBe("manual");
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  // #326-T03
  it("reads the reason of a 200 ignored, and treats a 200 of any other shape as unexpected", async () => {
    const ignored = (reason: string) =>
      new Response(JSON.stringify({ version: 1, status: "ignored", reason }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    expect(await send(answering(ignored("not_claimable")).fetch)).toEqual({
      kind: "ignored",
      reason: "not_claimable",
    });
    expect(await send(answering(ignored("not_capable")).fetch)).toEqual({
      kind: "ignored",
      reason: "not_capable",
    });
    for (const body of [
      "",
      "<html>a proxy page</html>",
      JSON.stringify({ version: 1, status: "accepted" }),
      JSON.stringify({ version: 1, status: "ignored", reason: "Bad Reason!" }),
      "x".repeat(5000),
    ])
      expect(
        await send(answering(new Response(body, { status: 200 })).fetch),
      ).toEqual({ kind: "rejected", status: 200 });
  });

  // #326-T04
  it("reads only the status and Retry-After of a 429 or 503, never the body", async () => {
    for (const status of [429, 503] as const) {
      const response = new Response("a body the sender must not read", {
        status,
        headers: { "retry-after": "120" },
      });
      const text = vi.spyOn(response, "text");
      const json = vi.spyOn(response, "json");
      expect(await send(answering(response).fetch)).toEqual({
        kind: "retry_later",
        status,
        retryAfterSeconds: 120,
      });
      expect(text).not.toHaveBeenCalled();
      expect(json).not.toHaveBeenCalled();
    }
    expect(
      await send(answering(new Response(null, { status: 503 })).fetch),
    ).toEqual({ kind: "retry_later", status: 503, retryAfterSeconds: null });
  });

  // #326-T03
  it("calls any other 5xx a server error", async () => {
    for (const status of [500, 502, 504])
      expect(
        await send(answering(new Response(null, { status })).fetch),
      ).toEqual({ kind: "server_error", status });
  });

  // #326-T05
  it("rejects any other status, redirects included", async () => {
    for (const status of [204, 301, 302, 400, 401, 403, 404, 413, 418])
      expect(
        await send(answering(new Response(null, { status })).fetch),
      ).toEqual({ kind: "rejected", status });
  });

  // #326-T06
  it("gives up on an endpoint that hangs, after the timeout", async () => {
    const hanging: DispatchFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      });
    const started = Date.now();
    expect(await send(hanging, 40)).toEqual({ kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  // #326-T06
  it("gives up on a 200 whose body never ends", async () => {
    const stalled = new Response(
      new ReadableStream({
        start() {
          /* never enqueues, never closes */
        },
      }),
      { status: 200 },
    );
    expect(await send(answering(stalled).fetch, 40)).toEqual({
      kind: "timeout",
    });
  });

  // #326-T06
  it("reports a failed connection without the error's text", async () => {
    const failing: DispatchFetch = () =>
      Promise.reject(
        new TypeError(`fetch failed: ${URL_OK} ${SECRET} ${SIGNATURE}`),
      );
    const result = await send(failing);
    expect(result).toEqual({ kind: "network_error" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe("Retry-After", () => {
  // #326-T04
  it("is read as seconds or as a date, and anything else is ignored", () => {
    expect(parseRetryAfter("120", NOW)).toBe(120);
    expect(parseRetryAfter(" 0 ", NOW)).toBe(0);
    expect(parseRetryAfter("Sat, 10 Oct 2026 12:05:00 GMT", NOW)).toBe(300);
    expect(parseRetryAfter("Sat, 10 Oct 2026 11:00:00 GMT", NOW)).toBe(0);
    for (const bad of [null, "", "soon", "-5", "1.5", "99999999999999999999"])
      expect(parseRetryAfter(bad, NOW)).toBeNull();
  });
});
