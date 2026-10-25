// SPDX-License-Identifier: LicenseRef-Proprietary

// The HTTP side of the dispatch webhook: one POST, an 8 second limit for all of it (connect, answer and
// body), and a closed list of what the answer can mean. Only the status, `Retry-After` and, for a 200,
// the small `ignored` body are read; the body of every other answer is dropped unread, and nothing of an
// error (its text may quote the URL) is kept. No redirect is followed: the signed request goes to the
// configured address and nowhere else.
import "server-only";
import type { DispatchRequest } from "./request.ts";

export const DISPATCH_TIMEOUT_MS = 8000;
/** A 200 `ignored` body is a few dozen bytes; more than this is not the Dispatcher. */
const MAX_IGNORED_BODY_BYTES = 1024;
const REASON = /^[a-z][a-z0-9_]{0,63}$/;
const RETRY_AFTER_SECONDS = /^\d{1,10}$/;
const HTTP_DATE =
  /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

export type DispatchFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

/** What one send came to. Holds no body, no error text and no header of the answer except `Retry-After`. */
export type SendResult =
  | { kind: "accepted" }
  | { kind: "ignored"; reason: string }
  | { kind: "retry_later"; status: 429 | 503; retryAfterSeconds: number | null }
  | { kind: "server_error"; status: number }
  | { kind: "timeout" }
  | { kind: "network_error" }
  | { kind: "rejected"; status: number };

/** `Retry-After` as whole seconds from now: delta-seconds, or an HTTP date. Null for anything else. */
export function parseRetryAfter(
  header: string | null,
  now: Date,
): number | null {
  const text = header?.trim();
  if (text === undefined || text === "") return null;
  if (RETRY_AFTER_SECONDS.test(text)) return Number(text);
  if (!HTTP_DATE.test(text)) return null;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now.getTime()) / 1000));
}

/** The promise, or a rejection when the signal fires first: a body that stalls must not outlive the limit. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

async function readIgnoredReason(
  response: Response,
  signal: AbortSignal,
): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (reader === undefined) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await untilAborted(reader.read(), signal);
    if (done) break;
    size += value.byteLength;
    if (size > MAX_IGNORED_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { version, status, reason } = parsed as Record<string, unknown>;
    if (version !== 1 || status !== "ignored") return undefined;
    return typeof reason === "string" && REASON.test(reason)
      ? reason
      : undefined;
  } catch {
    return undefined;
  }
}

function dropBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

export async function sendDispatch(input: {
  url: string;
  request: DispatchRequest;
  fetch: DispatchFetch;
  timeoutMs: number;
  now: () => Date;
}): Promise<SendResult> {
  const signal = AbortSignal.timeout(input.timeoutMs);
  try {
    const response = await input.fetch(input.url, {
      method: "POST",
      headers: input.request.headers,
      body: input.request.body,
      redirect: "manual",
      cache: "no-store",
      signal,
    });
    const { status } = response;
    if (status === 202) {
      dropBody(response);
      return { kind: "accepted" };
    }
    if (status === 200) {
      const reason = await readIgnoredReason(response, signal);
      return reason === undefined
        ? { kind: "rejected", status }
        : { kind: "ignored", reason };
    }
    dropBody(response);
    if (status === 429 || status === 503)
      return {
        kind: "retry_later",
        status,
        retryAfterSeconds: parseRetryAfter(
          response.headers.get("retry-after"),
          input.now(),
        ),
      };
    if (status >= 500) return { kind: "server_error", status };
    return { kind: "rejected", status };
  } catch {
    return signal.aborted ? { kind: "timeout" } : { kind: "network_error" };
  }
}
