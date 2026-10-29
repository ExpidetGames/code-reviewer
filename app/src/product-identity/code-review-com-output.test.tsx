// SPDX-License-Identifier: LicenseRef-Proprietary

// #715 (cut 7), #740: the brand is a value the application hands to the code that writes the words (`ProductIdentity`), not
// something that code imports. This test holds everything that value ends up in, as code-review.com shows it today: the
// five mails, the words of the model chooser and the brand on a page, and (#740) the check run, the verdict, the GitHub App
// manifest, the refusal notices and the message modules. The golden file was recorded from the code before the cut and before
// the sweep; to record it again on purpose: `WRITE_PRODUCT_GOLDEN=1 pnpm exec vitest run --project unit <this file>`.
//
// @vitest-environment node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { productOutput } from "../test-support/product-output.tsx";
import { getProductIdentity } from "./current.ts";

const GOLDEN = join(import.meta.dirname, "code-review-com-output.golden.json");

describe("everything the product name ends up in", () => {
  // #715-T07
  it("reads as it did before the brand became a value the application hands in", () => {
    const actual = JSON.parse(
      JSON.stringify(productOutput(getProductIdentity())),
    ) as unknown;
    if (process.env.WRITE_PRODUCT_GOLDEN === "1")
      writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);

    expect(actual).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")));
    // The golden file is not empty by accident: the name is in every mail.
    expect(
      JSON.stringify(actual).match(/code-review\.com/g)?.length,
    ).toBeGreaterThan(20);
  });
});
