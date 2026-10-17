// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  IMAGE_INPUT_PATHS,
  parseDotenv,
  pairFrom,
  pairToEnv,
  pairToMeta,
  pairsEqual,
} from "./pair.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = `sha256:${"a".repeat(64)}`;
const GOOD = {
  snapshotId: "snap_example01",
  imageDigest: DIGEST,
  commit: COMMIT,
};

describe("the snapshot pair", () => {
  // #403-T13
  it("takes the three values from the variables of the Dispatcher project", () => {
    expect(
      pairFrom({
        SANDBOX_SNAPSHOT_ID: "snap_example01",
        SANDBOX_IMAGE_DIGEST: DIGEST,
        SANDBOX_SNAPSHOT_COMMIT: COMMIT,
      }),
    ).toEqual(GOOD);
  });

  // #403-T13
  it.each([
    [
      "no id",
      { SANDBOX_IMAGE_DIGEST: DIGEST, SANDBOX_SNAPSHOT_COMMIT: COMMIT },
    ],
    [
      "no digest",
      {
        SANDBOX_SNAPSHOT_ID: "snap_example01",
        SANDBOX_SNAPSHOT_COMMIT: COMMIT,
      },
    ],
    [
      "no commit",
      { SANDBOX_SNAPSHOT_ID: "snap_example01", SANDBOX_IMAGE_DIGEST: DIGEST },
    ],
    [
      "an empty value",
      {
        SANDBOX_SNAPSHOT_ID: "",
        SANDBOX_IMAGE_DIGEST: DIGEST,
        SANDBOX_SNAPSHOT_COMMIT: COMMIT,
      },
    ],
    [
      "a digest that is not an image id",
      {
        SANDBOX_SNAPSHOT_ID: "snap_example01",
        SANDBOX_IMAGE_DIGEST: "latest",
        SANDBOX_SNAPSHOT_COMMIT: COMMIT,
      },
    ],
    [
      "a short commit",
      {
        SANDBOX_SNAPSHOT_ID: "snap_example01",
        SANDBOX_IMAGE_DIGEST: DIGEST,
        SANDBOX_SNAPSHOT_COMMIT: "abc1234",
      },
    ],
    [
      "an id with a space or a newline",
      {
        SANDBOX_SNAPSHOT_ID: "snap x\ny",
        SANDBOX_IMAGE_DIGEST: DIGEST,
        SANDBOX_SNAPSHOT_COMMIT: COMMIT,
      },
    ],
  ])("is no pair with %s", (_name, variables) => {
    expect(pairFrom(variables)).toBeUndefined();
  });

  // #403-T13
  it("writes the same pair as variables and as deployment meta, under the names the other steps read", () => {
    expect(pairToEnv(GOOD)).toEqual({
      SANDBOX_SNAPSHOT_ID: "snap_example01",
      SANDBOX_IMAGE_DIGEST: DIGEST,
      SANDBOX_SNAPSHOT_COMMIT: COMMIT,
    });
    expect(pairToMeta(GOOD)).toEqual({
      sandboxSnapshotId: "snap_example01",
      sandboxImageDigest: DIGEST,
      sandboxSnapshotCommit: COMMIT,
    });
  });

  // #403-T13
  it("compares pairs value by value", () => {
    expect(pairsEqual(GOOD, { ...GOOD })).toBe(true);
    expect(pairsEqual(GOOD, { ...GOOD, snapshotId: "snap_example02" })).toBe(
      false,
    );
    expect(pairsEqual(GOOD, undefined)).toBe(false);
  });
});

describe("a pulled environment file", () => {
  // #403-T13
  it("reads quoted, single quoted and bare values and ignores comments and blank lines", () => {
    expect(
      parseDotenv(
        [
          "# Created by Vercel CLI",
          "",
          'SANDBOX_SNAPSHOT_ID="snap_example01"',
          "SANDBOX_IMAGE_DIGEST='sha256:abc'",
          "PLAIN=value",
          'EMPTY=""',
          "export EXPORTED=1",
          "not a line",
        ].join("\n"),
      ),
    ).toEqual({
      SANDBOX_SNAPSHOT_ID: "snap_example01",
      SANDBOX_IMAGE_DIGEST: "sha256:abc",
      PLAIN: "value",
      EMPTY: "",
      EXPORTED: "1",
    });
  });
});

describe("the inputs of the Worker image", () => {
  const root = join(import.meta.dirname, "..", "..", "..");
  const dockerfile = readFileSync(join(root, "runner/Dockerfile"), "utf8");

  // #403-T14
  it("cover every file the Dockerfile copies from the build context", () => {
    const sources = dockerfile
      .split("\n")
      .filter((line) => /^COPY\s/.test(line) && !line.includes("--from="))
      .flatMap((line) =>
        line
          .replace(/^COPY\s+/, "")
          .split(/\s+/)
          .filter((word) => !word.startsWith("--"))
          .slice(0, -1),
      );
    expect(sources.length).toBeGreaterThan(5);
    for (const source of sources)
      expect(
        IMAGE_INPUT_PATHS.some(
          (path) => source === path || source.startsWith(`${path}/`),
        ),
        source,
      ).toBe(true);
  });

  // #403-T14
  it("name the build tooling of the snapshot and its VM script, and only paths that exist", async () => {
    const { existsSync } = await import("node:fs");
    expect(IMAGE_INPUT_PATHS).toContain("docker/sandbox");
    expect(IMAGE_INPUT_PATHS).toContain("dispatcher/src/snapshot");
    for (const path of IMAGE_INPUT_PATHS)
      expect(existsSync(join(root, path)), path).toBe(true);
  });
});
