// SPDX-License-Identifier: Apache-2.0

// One request for the models.dev body (#548). The body is untrusted: it is read with a size cap before anything parses
// it (a body that grows without end is cut at the cap, a body that announces more is refused at once), under a time
// limit that also covers reading it, and a redirect is never followed. Every way it can fail ends in a stable code
// (`errors.ts`); no code carries the address or anything the server said.
import "server-only";
import type { ModelsDevFetchErrorCode } from "./errors.ts";

/** About four times the size of the real catalog (5.8 MB on 2026-10-19). */
export const MAX_BODY_BYTES = 24 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 60_000;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type FetchResult =
  | { ok: true; body: unknown }
  | { ok: false; code: ModelsDevFetchErrorCode };

type Options = {
  url: string;
  maxBytes?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
};

async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array | "too_large"> {
  const announced = Number(response.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return "too_large";
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return "too_large";
    }
    parts.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  return body;
}

export async function fetchModelsDev({
  url,
  maxBytes = MAX_BODY_BYTES,
  timeoutMs = FETCH_TIMEOUT_MS,
  fetchImpl = fetch,
}: Options): Promise<FetchResult> {
  let bytes: Uint8Array | "too_large";
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, code: "models_dev_http_status" };
    }
    bytes = await readCapped(response, maxBytes);
  } catch {
    // The text of a failed fetch can name the address; the class is all that is kept.
    return { ok: false, code: "models_dev_unreachable" };
  }
  if (bytes === "too_large") return { ok: false, code: "models_dev_too_large" };
  try {
    return { ok: true, body: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, code: "models_dev_invalid_json" };
  }
}
