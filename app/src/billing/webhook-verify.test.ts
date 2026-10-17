// SPDX-License-Identifier: Apache-2.0

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PADDLE_SIGNATURE_ERROR_CODES,
  PADDLE_SIGNATURE_TOLERANCE_SECONDS,
  verifyPaddleSignature,
} from "./webhook-verify.ts";

const SECRET = "pdl_ntfset_test_secret_value";
const BODY = '{"event_id":"evt_01test","event_type":"subscription.updated"}';
const TS = 1_700_000_000;
// The HMAC-SHA256 of `${TS}:${BODY}` made with `openssl dgst -sha256 -hmac`, independent of this code.
const KNOWN_H1 =
  "c6fe65a9372821b0003756a6bde3c26ddd5f5afc79b7610c76e67a950f12c965";

const at = (seconds: number) => new Date(seconds * 1000);

/** Signs like Paddle does, so each case builds its own header. */
function h1Of(ts: number, body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(`${ts}:${body}`).digest("hex");
}

function verify(
  header: string | null | undefined,
  overrides: Partial<Parameters<typeof verifyPaddleSignature>[0]> = {},
) {
  return verifyPaddleSignature({
    header,
    rawBody: BODY,
    secret: SECRET,
    now: at(TS + 1),
    ...overrides,
  });
}

describe("verifyPaddleSignature", () => {
  // #436-T01
  it("accepts a correctly signed body", () => {
    expect(h1Of(TS, BODY)).toBe(KNOWN_H1);
    expect(verify(`ts=${TS};h1=${KNOWN_H1}`)).toEqual({
      ok: true,
      timestamp: TS,
    });
  });

  // #436-T01
  it("accepts an uppercase hex digest and spaces around the parts", () => {
    expect(verify(`ts=${TS}; h1=${KNOWN_H1.toUpperCase()}`)).toEqual({
      ok: true,
      timestamp: TS,
    });
  });

  // #436-T01
  it("signs the raw bytes: a body that is JSON-equal but not byte-equal is refused", () => {
    const pretty = BODY.replace(",", ", ");
    expect(verify(`ts=${TS};h1=${KNOWN_H1}`, { rawBody: pretty })).toEqual({
      ok: false,
      code: "signature_mismatch",
    });
  });

  // #436-T02
  it("refuses a wrong secret and an altered body with signature_mismatch", () => {
    const header = `ts=${TS};h1=${KNOWN_H1}`;
    expect(verify(header, { secret: "pdl_ntfset_other" })).toEqual({
      ok: false,
      code: "signature_mismatch",
    });
    expect(verify(header, { rawBody: `${BODY} ` })).toEqual({
      ok: false,
      code: "signature_mismatch",
    });
  });

  // #436-T02
  it("refuses a header that is missing or empty with signature_missing", () => {
    for (const header of [null, undefined, "", "   "])
      expect(verify(header)).toEqual({ ok: false, code: "signature_missing" });
  });

  // #436-T02
  it("refuses a malformed header with signature_malformed", () => {
    const malformed = [
      "garbage",
      `h1=${KNOWN_H1}`,
      `ts=${TS}`,
      `ts=${TS};h1=`,
      `ts=${TS};h1=not-hex`,
      `ts=${TS};h1=${KNOWN_H1.slice(2)}`,
      `ts=abc;h1=${KNOWN_H1}`,
      `ts=-5;h1=${KNOWN_H1}`,
      `ts=${TS};ts=${TS};h1=${KNOWN_H1}`,
      `ts=;h1=${KNOWN_H1}`,
      `ts=${TS};h1`,
    ];
    for (const header of malformed)
      expect(verify(header), header).toEqual({
        ok: false,
        code: "signature_malformed",
      });
  });

  // #436-T02
  it("refuses a valid signature whose ts is outside the tolerance, past and future", () => {
    const header = `ts=${TS};h1=${KNOWN_H1}`;
    const tolerance = PADDLE_SIGNATURE_TOLERANCE_SECONDS;
    expect(verify(header, { now: at(TS + tolerance) }).ok).toBe(true);
    expect(verify(header, { now: at(TS + tolerance + 1) })).toEqual({
      ok: false,
      code: "timestamp_out_of_tolerance",
    });
    expect(verify(header, { now: at(TS - tolerance) }).ok).toBe(true);
    expect(verify(header, { now: at(TS - tolerance - 1) })).toEqual({
      ok: false,
      code: "timestamp_out_of_tolerance",
    });
  });

  // #436-T02
  it("uses a tolerance of five minutes by default and honours a configured one", () => {
    expect(PADDLE_SIGNATURE_TOLERANCE_SECONDS).toBe(300);
    const header = `ts=${TS};h1=${KNOWN_H1}`;
    expect(verify(header, { now: at(TS + 10), toleranceSeconds: 5 })).toEqual({
      ok: false,
      code: "timestamp_out_of_tolerance",
    });
    expect(verify(header, { now: at(TS + 10), toleranceSeconds: 10 }).ok).toBe(
      true,
    );
  });

  // #436-T02
  it("takes a wider tolerance as a parameter, for retries that keep the ts of the first try (research S3)", () => {
    const header = `ts=${TS};h1=${KNOWN_H1}`;
    const threeDays = 3 * 24 * 60 * 60;
    const twoDaysLater = at(TS + 2 * 24 * 60 * 60);
    expect(verify(header, { now: twoDaysLater }).ok).toBe(false);
    expect(
      verify(header, { now: twoDaysLater, toleranceSeconds: threeDays }),
    ).toEqual({ ok: true, timestamp: TS });
    // Wide or not, the signature still binds the body and the secret.
    expect(
      verify(header, {
        now: twoDaysLater,
        toleranceSeconds: threeDays,
        rawBody: `${BODY} `,
      }),
    ).toEqual({ ok: false, code: "signature_mismatch" });
    expect(
      verify(header, {
        now: twoDaysLater,
        toleranceSeconds: threeDays,
        secret: "another_secret",
      }),
    ).toEqual({ ok: false, code: "signature_mismatch" });
  });

  // #436-T02
  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])(
    "refuses a tolerance of %s instead of accepting every age",
    (toleranceSeconds) => {
      const header = `ts=${TS};h1=${KNOWN_H1}`;
      expect(
        verify(header, { now: at(TS + 10_000_000), toleranceSeconds }),
      ).toEqual({ ok: false, code: "tolerance_invalid" });
      expect(verify(header, { toleranceSeconds })).toEqual({
        ok: false,
        code: "tolerance_invalid",
      });
    },
  );

  // #436-T02
  it("accepts a tolerance of zero: only the exact second", () => {
    const header = `ts=${TS};h1=${KNOWN_H1}`;
    expect(verify(header, { now: at(TS), toleranceSeconds: 0 }).ok).toBe(true);
    expect(verify(header, { now: at(TS + 1), toleranceSeconds: 0 }).ok).toBe(
      false,
    );
  });

  // #436-T02
  it("checks the signature before the age, so an unsigned replay learns nothing about the clock", () => {
    expect(
      verify(`ts=${TS};h1=${"0".repeat(64)}`, { now: at(TS + 10_000) }),
    ).toEqual({ ok: false, code: "signature_mismatch" });
  });

  // #436-T02
  it("refuses everything when no secret is configured, even a signature made with an empty key", () => {
    const header = `ts=${TS};h1=${h1Of(TS, BODY, "")}`;
    expect(verify(header, { secret: "" })).toEqual({
      ok: false,
      code: "secret_missing",
    });
  });

  // #436-T02
  it("has one distinct stable code per refusal", () => {
    expect([...PADDLE_SIGNATURE_ERROR_CODES].sort()).toEqual([
      "secret_missing",
      "signature_malformed",
      "signature_mismatch",
      "signature_missing",
      "timestamp_out_of_tolerance",
      "tolerance_invalid",
    ]);
  });

  // #436-T03
  it("accepts two h1 values when one of them is valid, in either position", () => {
    const wrong = h1Of(TS, BODY, "pdl_ntfset_rotated_out");
    expect(verify(`ts=${TS};h1=${wrong};h1=${KNOWN_H1}`).ok).toBe(true);
    expect(verify(`ts=${TS};h1=${KNOWN_H1};h1=${wrong}`).ok).toBe(true);
  });

  // #436-T03
  it("refuses two h1 values when neither is valid", () => {
    const a = h1Of(TS, BODY, "pdl_ntfset_a");
    const b = h1Of(TS, BODY, "pdl_ntfset_b");
    expect(verify(`ts=${TS};h1=${a};h1=${b}`)).toEqual({
      ok: false,
      code: "signature_mismatch",
    });
  });

  // #436-T03
  it("ignores keys it does not know", () => {
    expect(verify(`ts=${TS};h2=${"a".repeat(64)};h1=${KNOWN_H1}`).ok).toBe(
      true,
    );
  });
});

describe("the comparison", () => {
  // #436-T04
  it("goes through timingSafeEqual and never compares digests with an operator", () => {
    const source = readFileSync(
      new URL("./webhook-verify.ts", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(
      /import\s*\{[^}]*\btimingSafeEqual\b[^}]*\}\s*from\s*"node:crypto"/,
    );
    expect(source).toMatch(/\btimingSafeEqual\(/);
    // No `===`, `!==`, `==`, `!=` or localeCompare against a value named like a digest or signature.
    expect(source).not.toMatch(
      /\b(?:h1|digest|expected|signature|candidate)\w*\s*(?:===|!==|==|!=)/i,
    );
    expect(source).not.toMatch(
      /(?:===|!==|==|!=)\s*(?:h1|digest|expected|signature|candidate)\b/i,
    );
    expect(source).not.toMatch(/localeCompare|\.equals\(/);
  });
});
