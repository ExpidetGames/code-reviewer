// SPDX-License-Identifier: Apache-2.0

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  STRIPE_SIGNATURE_ERROR_CODES,
  STRIPE_SIGNATURE_TOLERANCE_SECONDS,
  verifyStripeSignature,
} from "./stripe-webhook-verify.ts";

const SECRET = "whsec_test_secret_value";
const BODY = '{"id":"evt_test_1","object":"event","type":"charge.refunded"}';
const T = 1_700_000_000;
// The HMAC-SHA256 of `${T}.${BODY}` made with `openssl dgst -sha256 -hmac`, independent of this code.
const KNOWN_V1 =
  "a50bbd80590d7bc4488992e121364b36ce1bc32bcfb88b45ece13140626ec41a";
const OTHER_SECRET_V1 =
  "d7f04cf7611b66ef303f670dd1e9c43ea15e39665bba9f889b20f910d09c3e44";

const at = (seconds: number) => new Date(seconds * 1000);

/** Signs like Stripe does, so each case builds its own header. */
function v1Of(t: number, body: string | Uint8Array, secret = SECRET): string {
  return createHmac("sha256", secret)
    .update(`${t}.`)
    .update(body)
    .digest("hex");
}

function verify(
  header: string | null | undefined,
  overrides: Partial<Parameters<typeof verifyStripeSignature>[0]> = {},
) {
  return verifyStripeSignature({
    header,
    rawBody: BODY,
    secret: SECRET,
    now: at(T + 1),
    ...overrides,
  });
}

describe("verifyStripeSignature", () => {
  // #500-T07
  it("accepts a correctly signed body", () => {
    expect(v1Of(T, BODY)).toBe(KNOWN_V1);
    expect(verify(`t=${T},v1=${KNOWN_V1}`)).toEqual({
      ok: true,
      timestamp: T,
    });
  });

  // #500-T07
  it("accepts the header as Stripe sends it in test mode, with a v0 signature and in any order", () => {
    const v0 = "0".repeat(64);
    expect(verify(`t=${T},v1=${KNOWN_V1},v0=${v0}`)).toEqual({
      ok: true,
      timestamp: T,
    });
    expect(verify(`v0=${v0},v1=${KNOWN_V1},t=${T}`)).toEqual({
      ok: true,
      timestamp: T,
    });
  });

  // #500-T07
  it("accepts an uppercase digest, spaces around the parts and a scheme it does not know", () => {
    expect(verify(`t=${T}, v1=${KNOWN_V1.toUpperCase()}, v2=anything`)).toEqual({
      ok: true,
      timestamp: T,
    });
  });

  // #500-T07
  it("signs the raw bytes: a body that is JSON-equal but not byte-equal is refused", () => {
    const pretty = BODY.replace(",", ", ");
    expect(verify(`t=${T},v1=${KNOWN_V1}`, { rawBody: pretty })).toEqual({
      ok: false,
      code: "signature_mismatch",
    });
  });

  // #500-T07
  it("verifies the bytes it is given, also bytes that are not valid UTF-8 or that start with a byte order mark", () => {
    const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, 0x7b, 0xff, 0xfe, 0x7d]);
    const header = `t=${T},v1=${v1Of(T, bytes)}`;
    expect(verify(header, { rawBody: bytes })).toEqual({
      ok: true,
      timestamp: T,
    });
    // The same bytes decoded as text and encoded again are other bytes.
    const decoded = new TextDecoder().decode(bytes);
    expect(verify(header, { rawBody: decoded })).toEqual({
      ok: false,
      code: "signature_mismatch",
    });
  });

  // #500-T07
  it("takes the body as bytes or as the same text", () => {
    const header = `t=${T},v1=${KNOWN_V1}`;
    expect(verify(header, { rawBody: new TextEncoder().encode(BODY) })).toEqual(
      { ok: true, timestamp: T },
    );
  });

  // #500-T07
  it("refuses a wrong secret and an altered body with signature_mismatch", () => {
    const header = `t=${T},v1=${KNOWN_V1}`;
    expect(verify(header, { secret: "whsec_other" })).toEqual({
      ok: false,
      code: "signature_mismatch",
    });
    expect(verify(header, { rawBody: `${BODY} ` })).toEqual({
      ok: false,
      code: "signature_mismatch",
    });
    expect(verify(`t=${T},v1=${OTHER_SECRET_V1}`)).toEqual({
      ok: false,
      code: "signature_mismatch",
    });
  });

  // #500-T07
  it("refuses a signature that is made for another timestamp", () => {
    expect(verify(`t=${T + 1},v1=${KNOWN_V1}`)).toEqual({
      ok: false,
      code: "signature_mismatch",
    });
  });

  // #500-T07
  it("refuses a header that is missing or empty with signature_missing", () => {
    for (const header of [undefined, null, "", "   "])
      expect(verify(header)).toEqual({
        ok: false,
        code: "signature_missing",
      });
  });

  // #500-T07
  it.each([
    "garbage",
    `t=${T}`,
    `v1=${KNOWN_V1}`,
    `t=abc,v1=${KNOWN_V1}`,
    `t=,v1=${KNOWN_V1}`,
    `t=-5,v1=${KNOWN_V1}`,
    `t=1.5,v1=${KNOWN_V1}`,
    `t=${T},t=${T},v1=${KNOWN_V1}`,
    `t=${T},v1=nothex`,
    `t=${T},v1=${KNOWN_V1.slice(0, 62)}`,
    `t=${T},v1`,
    `t=${T},v1=${KNOWN_V1},v1`,
    `t=${"9".repeat(40)},v1=${KNOWN_V1}`,
  ])("refuses the malformed header %j with signature_malformed", (header) => {
    expect(verify(header)).toEqual({
      ok: false,
      code: "signature_malformed",
    });
  });

  // #500-T07
  it("accepts two v1 values where one is valid, in either position", () => {
    expect(verify(`t=${T},v1=${OTHER_SECRET_V1},v1=${KNOWN_V1}`)).toEqual({
      ok: true,
      timestamp: T,
    });
    expect(verify(`t=${T},v1=${KNOWN_V1},v1=${OTHER_SECRET_V1}`)).toEqual({
      ok: true,
      timestamp: T,
    });
  });

  // #500-T07
  it("refuses two v1 values where none is valid", () => {
    expect(
      verify(`t=${T},v1=${OTHER_SECRET_V1},v1=${"1".repeat(64)}`),
    ).toEqual({ ok: false, code: "signature_mismatch" });
  });

  // #500-T07
  it("refuses a timestamp that is too old or too far ahead, with a good signature", () => {
    const tolerance = STRIPE_SIGNATURE_TOLERANCE_SECONDS;
    expect(tolerance).toBe(300);
    const header = `t=${T},v1=${KNOWN_V1}`;
    expect(verify(header, { now: at(T + tolerance) })).toEqual({
      ok: true,
      timestamp: T,
    });
    expect(verify(header, { now: at(T + tolerance + 1) })).toEqual({
      ok: false,
      code: "timestamp_out_of_tolerance",
    });
    expect(verify(header, { now: at(T - tolerance) })).toEqual({
      ok: true,
      timestamp: T,
    });
    expect(verify(header, { now: at(T - tolerance - 1) })).toEqual({
      ok: false,
      code: "timestamp_out_of_tolerance",
    });
  });

  // #500-T07
  it("uses the tolerance it is given", () => {
    const header = `t=${T},v1=${KNOWN_V1}`;
    expect(
      verify(header, { now: at(T + 3600), toleranceSeconds: 3600 }),
    ).toEqual({ ok: true, timestamp: T });
    expect(verify(header, { now: at(T + 11), toleranceSeconds: 10 })).toEqual({
      ok: false,
      code: "timestamp_out_of_tolerance",
    });
  });

  // #500-T07
  it("never reports the age of a message whose signature is bad", () => {
    // Old, and bad: the answer is the signature, not the clock.
    const old = at(T + 10_000);
    expect(verify(`t=${T},v1=${OTHER_SECRET_V1}`, { now: old })).toEqual({
      ok: false,
      code: "signature_mismatch",
    });
    expect(verify(`t=${T},v1=${KNOWN_V1}`, { now: old, secret: "x" })).toEqual({
      ok: false,
      code: "signature_mismatch",
    });
    expect(verify(`t=${T},v1=${KNOWN_V1}`, { now: old, rawBody: "{}" })).toEqual(
      { ok: false, code: "signature_mismatch" },
    );
  });

  // #500-T07
  it("compares every candidate and leaves no early exit that depends on the match", () => {
    // The loop must not stop at the first match or the first mismatch. Observable proxy: both orders agree.
    const bad = "2".repeat(64);
    const a = verify(`t=${T},v1=${KNOWN_V1},v1=${bad},v1=${bad}`);
    const b = verify(`t=${T},v1=${bad},v1=${bad},v1=${KNOWN_V1}`);
    expect(a).toEqual(b);
    expect(a).toEqual({ ok: true, timestamp: T });
  });

  // #500-T08
  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "refuses the tolerance %s with tolerance_invalid, before it looks at the header",
    (toleranceSeconds) => {
      expect(verify(`t=${T},v1=${KNOWN_V1}`, { toleranceSeconds })).toEqual({
        ok: false,
        code: "tolerance_invalid",
      });
      expect(verify(null, { toleranceSeconds })).toEqual({
        ok: false,
        code: "tolerance_invalid",
      });
    },
  );

  // #500-T08
  it("refuses an empty secret with secret_missing, even for a header signed with the empty key", () => {
    const emptyKeyV1 = createHmac("sha256", "")
      .update(`${T}.${BODY}`)
      .digest("hex");
    expect(verify(`t=${T},v1=${emptyKeyV1}`, { secret: "" })).toEqual({
      ok: false,
      code: "secret_missing",
    });
    expect(verify(null, { secret: "" })).toEqual({
      ok: false,
      code: "secret_missing",
    });
  });

  // #500-T08
  it("has a closed set of codes and answers with nothing else", () => {
    expect([...STRIPE_SIGNATURE_ERROR_CODES].sort()).toEqual([
      "secret_missing",
      "signature_malformed",
      "signature_mismatch",
      "signature_missing",
      "timestamp_out_of_tolerance",
      "tolerance_invalid",
    ]);
    const verdict = verify(`t=${T},v1=${OTHER_SECRET_V1}`);
    if (verdict.ok) throw new Error("expected a refusal");
    expect(STRIPE_SIGNATURE_ERROR_CODES).toContain(verdict.code);
    expect(Object.keys(verdict).sort()).toEqual(["code", "ok"]);
  });
});
