// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createKnownSecrets } from "./known-secrets.ts";

const ENV = { RUNNER_TOKEN: "runner-token-for-the-known-secrets-test" };

describe("the secrets to mask in a result", () => {
  // #426-T05
  it("are the environment's and every current key of the workspace", async () => {
    const known = createKnownSecrets({
      env: ENV,
      currentKeysFor: async () => ["key-of-provider-a", "key-of-provider-b"],
    });

    expect(await known("workspace-1")).toEqual([
      ENV.RUNNER_TOKEN,
      "key-of-provider-a",
      "key-of-provider-b",
    ]);
  });

  // #426-T05
  it("fail closed when the read of one provider's key throws: no list with fewer keys, the error reaches the caller", async () => {
    const known = createKnownSecrets({
      env: ENV,
      currentKeysFor: async () => {
        throw new Error("the read of the key of provider b failed");
      },
    });

    await expect(known("workspace-1")).rejects.toThrow(
      "the read of the key of provider b failed",
    );
  });
});
