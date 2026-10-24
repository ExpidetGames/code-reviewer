// SPDX-License-Identifier: LicenseRef-Proprietary

// One signed dispatch request, as contracts/dispatch-webhook.v1.json describes it: the closed body and the
// headers. Pure: the clock and the ids come in, nothing is sent here. The signature is the lower case hex
// HMAC-SHA-256 of `v1:{timestamp}:{dispatchId}:{rawBody}`, keyed with the secret of the key id.
import "server-only";
import { createHmac } from "node:crypto";
import type {
  DispatchStop,
  DispatchWebhook,
} from "../contracts/dispatch-webhook.ts";
import type { DispatchKey } from "./config.ts";

/** The header the platform's deployment protection accepts a bypass token in. */
export const BYPASS_HEADER = "x-vercel-protection-bypass";

/** The signature header value: `v1=` and the hexadecimal HMAC-SHA-256. */
export function signDispatch(input: {
  secret: string;
  timestamp: string;
  dispatchId: string;
  rawBody: string;
}): string {
  const message = `v1:${input.timestamp}:${input.dispatchId}:${input.rawBody}`;
  return `v1=${createHmac("sha256", input.secret).update(message, "utf8").digest("hex")}`;
}

export type DispatchRequestInput = {
  key: DispatchKey;
  bypassToken?: string;
  jobId: string;
  reviewKind: DispatchWebhook["reviewKind"];
  /** The job's attempt number (1 for the first); the contract allows 1 to 100. */
  attempt: number;
  dispatchId: string;
  now: Date;
};

export type DispatchRequest = {
  body: string;
  headers: Record<string, string>;
};

export function buildDispatchRequest(
  input: DispatchRequestInput,
): DispatchRequest {
  // A closed body: the keys below are all there is (no secret, no repository data). Key order is fixed
  // so the bytes are the same on every instance.
  const payload: DispatchWebhook = {
    version: 1,
    type: "job.ready",
    jobId: input.jobId,
    reviewKind: input.reviewKind,
    attempt: Math.min(100, Math.max(1, Math.trunc(input.attempt))),
    dispatchId: input.dispatchId,
    sentAt: input.now.toISOString(),
  };
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(input.now.getTime() / 1000));
  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-dispatch-timestamp": timestamp,
      "x-dispatch-id": input.dispatchId,
      "x-dispatch-key-id": input.key.kid,
      "x-dispatch-signature": signDispatch({
        secret: input.key.secret,
        timestamp,
        dispatchId: input.dispatchId,
        rawBody: body,
      }),
      ...(input.bypassToken === undefined
        ? {}
        : { [BYPASS_HEADER]: input.bypassToken }),
    },
  };
}

export type StopRequestInput = {
  key: DispatchKey;
  bypassToken?: string;
  jobId: string;
  /** New for every stop of a job and also the `x-dispatch-id` header: the receiver remembers it (replay protection). */
  stopId: string;
  now: Date;
};

/** The stop call (#487): the same signing rule as the wake-up call, over the closed `DispatchStop` body. */
export function buildStopRequest(input: StopRequestInput): DispatchRequest {
  const payload: DispatchStop = {
    version: 1,
    type: "job.stop",
    jobId: input.jobId,
    stopId: input.stopId,
    sentAt: input.now.toISOString(),
  };
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(input.now.getTime() / 1000));
  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-dispatch-timestamp": timestamp,
      "x-dispatch-id": input.stopId,
      "x-dispatch-key-id": input.key.kid,
      "x-dispatch-signature": signDispatch({
        secret: input.key.secret,
        timestamp,
        dispatchId: input.stopId,
        rawBody: body,
      }),
      ...(input.bypassToken === undefined
        ? {}
        : { [BYPASS_HEADER]: input.bypassToken }),
    },
  };
}
