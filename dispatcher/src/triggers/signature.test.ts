// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { verifyDispatch } from "../../../fakes/dispatcher-app/signing.ts";
import type { DispatchSigningVectors } from "../contracts/dispatch-webhook.ts";
import { readContract } from "../test-support/harness.ts";
import { verifyDispatchSignature } from "./signature.ts";

const vectors = readContract<DispatchSigningVectors>(
  "dispatch-signing-vectors.json",
);
const keys = [vectors.keys.current, vectors.keys.previous];

describe("the dispatch signature", () => {
  // #327-T10
  it.each(vectors.vectors.map((vector) => [vector.name, vector] as const))(
    "gives the verdict of the shared vector: %s",
    (_name, vector) => {
      const verdict = verifyDispatchSignature({
        keys,
        headers: vector.headers,
        rawBody: vector.body,
        nowSeconds: vector.now,
        toleranceSeconds: vectors.toleranceSeconds,
      });

      expect(verdict).toBe(vector.expected);
      // And the same one as the reference verifier the contract is proven against.
      expect(
        verifyDispatch({
          keys,
          headers: vector.headers,
          rawBody: vector.body,
          nowSeconds: vector.now,
          toleranceSeconds: vectors.toleranceSeconds,
        }),
      ).toBe(vector.expected);
    },
  );

  // #327-T10
  it("accepts the current and the previous key and refuses a key that was rotated out", () => {
    const [current, previous] = [vectors.keys.current, vectors.keys.previous];
    const valid = vectors.vectors.filter((vector) => vector.expected === "ok");
    const input = (kid: string, secret: string) => {
      const vector = valid.find(
        (candidate) => candidate.headers["x-dispatch-key-id"] === kid,
      );
      if (vector === undefined) throw new Error(`no vector for ${kid}`);
      return {
        headers: vector.headers,
        rawBody: vector.body,
        nowSeconds: vector.now,
        toleranceSeconds: 300,
        keys: [{ kid, secret }],
      };
    };

    expect(verifyDispatchSignature(input(current.kid, current.secret))).toBe(
      "ok",
    );
    expect(verifyDispatchSignature(input(previous.kid, previous.secret))).toBe(
      "ok",
    );
    expect(
      verifyDispatchSignature({
        ...input(previous.kid, previous.secret),
        keys: [{ kid: current.kid, secret: current.secret }],
      }),
    ).toBe("unknown_key");
  });
});
