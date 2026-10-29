// SPDX-License-Identifier: LicenseRef-Proprietary

// #715 (cut 7): the brand is a value the application hands to the code that writes the words (`ProductIdentity`), not
// something that code imports. This test holds everything that value ends up in, as code-review.com shows it today: the
// five mails, the words of the model chooser and the brand on a page. The golden file was recorded from the code before
// the cut; to record it again on purpose: `WRITE_PRODUCT_GOLDEN=1 pnpm exec vitest run --project unit <this file>`.
//
// @vitest-environment node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Brand, ProductName } from "../components/brand.tsx";
import * as modelChoice from "../copy/model-choice.ts";
import { CODE_REVIEW_COM } from "./code-review-com.ts";
import { balanceMessage } from "../mail/balance-message.ts";
import { invitationMessage } from "../mail/invitation-message.ts";
import { passwordResetMessage } from "../mail/password-reset-message.ts";
import { testMessage } from "../mail/test-mail.ts";
import { verificationMessage } from "../mail/verification-message.ts";

const GOLDEN = join(import.meta.dirname, "code-review-com-output.golden.json");
const LINK = "https://reviews.example.test/x?token=abc123";

function output() {
  const words = modelChoice.modelChoiceWords(CODE_REVIEW_COM);
  return {
    productName: CODE_REVIEW_COM.name,
    passwordReset: passwordResetMessage({
      product: CODE_REVIEW_COM,
      to: "ada@example.test",
      link: LINK,
      validForMinutes: 30,
    }),
    invitationAdmin: invitationMessage({
      product: CODE_REVIEW_COM,
      to: "ada@example.test",
      link: LINK,
      workspaceName: "Acme <Team>",
      inviterName: "Grace",
      role: "admin",
      validForDays: 7,
    }),
    invitationMember: invitationMessage({
      product: CODE_REVIEW_COM,
      to: "ada@example.test",
      link: LINK,
      workspaceName: "Acme",
      inviterName: "Grace",
      role: "member",
      validForDays: 7,
    }),
    verification: verificationMessage({
      product: CODE_REVIEW_COM,
      to: "ada@example.test",
      link: LINK,
      validForHours: 24,
    }),
    balanceLow: balanceMessage({
      product: CODE_REVIEW_COM,
      to: "ada@example.test",
      level: "low",
      workspaceName: "Acme",
      balanceText: "$1.20",
      link: LINK,
    }),
    balanceEmpty: balanceMessage({
      product: CODE_REVIEW_COM,
      to: "ada@example.test",
      level: "empty",
      workspaceName: "Acme",
      balanceText: "$0.00",
      link: LINK,
    }),
    balanceNegative: balanceMessage({
      product: CODE_REVIEW_COM,
      to: "ada@example.test",
      level: "negative",
      workspaceName: "Acme",
      balanceText: "-$0.40",
      link: LINK,
    }),
    testMail: testMessage(
      "ada@example.test",
      "https://reviews.example.test",
      CODE_REVIEW_COM,
    ),
    // Under the names the golden file was recorded with, when the five sentences were constants of the copy module.
    modelChoice: Object.fromEntries([
      ...Object.entries(modelChoice).filter(
        ([, value]) => typeof value === "string",
      ),
      ["MODEL_CHOICE_BILLED_NOTE", words.billedNote],
      ["MODEL_CHOICE_HINT", words.hint],
      ["MODEL_CHOICE_DEFAULT_SOURCE", words.defaultSource],
      ["MODEL_CHOICE_NONE_CHOSEN", words.noneChosen],
      ["MODEL_CHOICE_NONE_OFFERED", words.noneOffered],
    ]),
    brand: renderToStaticMarkup(<Brand product={CODE_REVIEW_COM} />),
    brandCompact: renderToStaticMarkup(
      <Brand product={CODE_REVIEW_COM} compact />,
    ),
    productNameInText: renderToStaticMarkup(
      <ProductName product={CODE_REVIEW_COM} />,
    ),
  };
}

describe("everything the product name ends up in", () => {
  // #715-T07
  it("reads as it did before the brand became a value the application hands in", () => {
    const actual = JSON.parse(JSON.stringify(output())) as unknown;
    if (process.env.WRITE_PRODUCT_GOLDEN === "1")
      writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);

    expect(actual).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")));
    // The golden file is not empty by accident: the name is in every mail.
    expect(
      JSON.stringify(actual).match(/code-review\.com/g)?.length,
    ).toBeGreaterThan(20);
  });
});
