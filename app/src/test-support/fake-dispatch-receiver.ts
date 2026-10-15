// SPDX-License-Identifier: Apache-2.0

// A stand-in for the Dispatcher's `POST /dispatch` (#326), as a `fetch` function: no socket, no network. It
// verifies every request with the reference verifier of the shared signing vectors
// (fakes/dispatcher-app/signing.ts), records what it received, and answers from a script (default `202`).
// The real receiver is the Dispatcher project (#327); both are held to contracts/dispatch-signing-vectors.json.
import {
  verifyDispatch,
  type DispatchKey,
  type DispatchVerdict,
} from "../../../fakes/dispatcher-app/signing.ts";
import type { DispatchWebhook } from "../contracts/dispatch-webhook.ts";
import type { DispatchFetch } from "../dispatch/send.ts";

export type ReceivedDispatch = {
  url: string;
  headers: Record<string, string>;
  rawBody: string;
  /** The body, when it is JSON. */
  body: DispatchWebhook | undefined;
  verdict: DispatchVerdict;
};

/** What the receiver does with the next request. */
export type ReceiverReply =
  | { status: number; headers?: Record<string, string>; body?: string }
  | "hang"
  | { fails: string };

export const accepted: ReceiverReply = {
  status: 202,
  body: JSON.stringify({ version: 1, status: "accepted" }),
};

export const ignored = (reason: string): ReceiverReply => ({
  status: 200,
  body: JSON.stringify({ version: 1, status: "ignored", reason }),
});

export function createFakeDispatchReceiver(options: {
  keys: DispatchKey[];
  now: () => Date;
}) {
  const received: ReceivedDispatch[] = [];
  const script: ReceiverReply[] = [];

  const fetch: DispatchFetch = (url, init) => {
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(
        ([name, value]) => [name.toLowerCase(), value],
      ),
    );
    const rawBody = typeof init.body === "string" ? init.body : "";
    let body: DispatchWebhook | undefined;
    try {
      body = JSON.parse(rawBody) as DispatchWebhook;
    } catch {
      body = undefined;
    }
    received.push({
      url,
      headers,
      rawBody,
      body,
      verdict: verifyDispatch({
        keys: options.keys,
        headers,
        rawBody,
        nowSeconds: Math.floor(options.now().getTime() / 1000),
        toleranceSeconds: 300,
      }),
    });

    const reply = script.shift() ?? accepted;
    if (reply === "hang")
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      });
    if ("fails" in reply) return Promise.reject(new TypeError(reply.fails));
    return Promise.resolve(
      new Response(reply.body ?? null, {
        status: reply.status,
        headers: reply.headers ?? {},
      }),
    );
  };

  return {
    fetch,
    received,
    /** The answers to the next requests, in order; after them it answers 202. */
    reply(...replies: ReceiverReply[]): void {
      script.push(...replies);
    },
  };
}
