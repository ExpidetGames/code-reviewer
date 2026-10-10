// Pins down the list of the keys handed out with a claim: it knows the key of a job, replaces it when
// the job is claimed again, and cannot grow without bound.
import { describe, expect, it } from "vitest";
import { createClaimedKeys } from "./claimed-keys.ts";

describe("the keys handed out with a claim", () => {
  it("knows the key of a job and nothing for another job", () => {
    const keys = createClaimedKeys();
    keys.remember("job-1", "key-one");

    expect(keys.keysOf("job-1")).toStrictEqual(["key-one"]);
    expect(keys.keysOf("job-2")).toStrictEqual([]);
  });

  it("keeps the key of the last claim when a job is claimed again", () => {
    const keys = createClaimedKeys();
    keys.remember("job-1", "key-one");
    keys.remember("job-1", "key-two");

    expect(keys.keysOf("job-1")).toStrictEqual(["key-two"]);
  });

  it("forgets the oldest job first once the limit is reached", () => {
    const keys = createClaimedKeys(2);
    keys.remember("job-1", "key-one");
    keys.remember("job-2", "key-two");
    keys.remember("job-3", "key-three");

    expect(keys.keysOf("job-1")).toStrictEqual([]);
    expect(keys.keysOf("job-2")).toStrictEqual(["key-two"]);
    expect(keys.keysOf("job-3")).toStrictEqual(["key-three"]);
  });
});
