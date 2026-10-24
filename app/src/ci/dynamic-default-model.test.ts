// SPDX-License-Identifier: LicenseRef-Proprietary

// The runner carries the capability descriptor of the shipped default Dynamic model (#264) and applies
// it only to that exact model id. The id lives in two places, the app's default setting and the
// runner's constant; this keeps them equal, so that changing one without the other fails here and not
// in a customer's first Dynamic run.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_DYNAMIC_MODEL } from "../review-settings/settings.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("the default Dynamic model", () => {
  // #264-T11
  it("is the model the runner has a built-in capability descriptor for", () => {
    const source = readFileSync(
      `${repoRoot}runner/src/code_reviewer_runner/dynamic_review/proxy.py`,
      "utf8",
    );
    const runnerModel = /^DEFAULT_DYNAMIC_MODEL = "([^"]+)"$/m.exec(
      source,
    )?.[1];

    expect(runnerModel).toBe(DEFAULT_DYNAMIC_MODEL);
  });
});
