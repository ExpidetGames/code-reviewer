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
import { getProductIdentity } from "./current.ts";
import * as authLoginErrors from "../auth/login-errors.ts";
import * as enablingCopy from "../billing/enabling-copy.ts";
import { describeCheck } from "../check-runs/check-text.ts";
import { CHECK_NAME, WITHDRAW_MESSAGE } from "../check-runs/service.ts";
import { verdictBody } from "../check-runs/verdict.ts";
import * as configNotices from "../config-status/notices.ts";
import * as planUsage from "../copy/plan-usage.ts";
import * as refusalCopy from "../copy/refusal-notice.ts";
import * as installationMessages from "../installation-binding/ui/messages.ts";
import {
  buildAppManifest,
  suggestedAppName,
} from "../integrations/providers/github-app/manifest.ts";
import { NOTICE_CODES, noticeBody } from "../refusal-notices/notice-text.ts";
import * as reviewSettingsMessages from "../review-settings/ui/messages.ts";
import * as errorCopy from "../runs/error-copy.ts";
import * as transportMessages from "../ui/transport-messages.ts";
import * as workspaceMessages from "../workspaces/ui/messages.ts";
import { balanceMessage } from "../mail/balance-message.ts";
import { invitationMessage } from "../mail/invitation-message.ts";
import { passwordResetMessage } from "../mail/password-reset-message.ts";
import { testMessage } from "../mail/test-mail.ts";
import { verificationMessage } from "../mail/verification-message.ts";

const GOLDEN = join(import.meta.dirname, "code-review-com-output.golden.json");
const LINK = "https://reviews.example.test/x?token=abc123";

// #740: the texts the sweep takes the name out of, as code-review.com shows them. A module's constants are taken as they
// are (a function is not data and drops out of the JSON), what a function writes is called with the codes that carry a word.
function texts() {
  const url = "https://reviews.example.test";
  const subjects = [
    { status: "queued" },
    { status: "running" },
    { status: "superseded" },
    { status: "succeeded", verdict: { kind: "skip", reason: "off" } },
    {
      status: "succeeded",
      verdict: { kind: "skip", reason: "review_incomplete" },
    },
    { status: "succeeded", verdict: { kind: "skip", reason: "no_severity" } },
    {
      status: "succeeded",
      verdict: { kind: "skip", reason: "findings_unknown" },
    },
    { status: "succeeded", verdict: { kind: "skip", reason: "no_model_work" } },
    { status: "cancelled", errorCode: "cost_limit_reached" },
    {
      status: "failed",
      errorCode: "cost_limit_reached",
      stoppedEarly: "cost_limit",
    },
    {
      status: "failed",
      errorCode: "cost_limit_reached",
      stoppedEarly: "project_cost_limit",
    },
    { status: "failed", errorCode: "billing_not_configured" },
    { status: "failed", errorCode: "a_code_nobody_knows" },
    { status: "failed", errorCode: null },
  ] as const;
  return {
    checkRuns: {
      checkName: CHECK_NAME,
      withdrawMessage: WITHDRAW_MESSAGE,
      verdictChanges: verdictBody({
        jobId: "job-1",
        event: "request_changes",
        mode: "blocking",
        blocking: 2,
        commentUrl: `${url}/c`,
      }),
      verdictApproved: verdictBody({
        jobId: "job-1",
        event: "approve",
        mode: "any",
        blocking: 0,
        commentUrl: null,
      }),
      checks: subjects.map((subject) =>
        describeCheck({
          errorCode: null,
          commentUrl: `${url}/c`,
          findings: null,
          stoppedEarly: null,
          ...subject,
        } as Parameters<typeof describeCheck>[0]),
      ),
    },
    manifest: {
      built: buildAppManifest({
        publicUrl: url,
        tenancy: "multi",
        name: suggestedAppName(url),
      }),
      suggestedName: suggestedAppName(url),
      suggestedNameWithoutHost: suggestedAppName("not a url"),
    },
    refusalNotices: {
      copy: refusalCopy,
      bodies: NOTICE_CODES.flatMap((code) => [
        noticeBody(code, "2026-10-01T00:00:00.000Z", null),
        noticeBody(code, "2026-10-01T00:00:00.000Z", `${url}/w/acme/plan`),
      ]),
    },
    errorCopy: {
      constants: errorCopy,
      costLimit: ["cost_limit", "project_cost_limit", "other", null].map(
        (stoppedEarly) =>
          errorCopy.describeErrorCode("cost_limit_reached", stoppedEarly),
      ),
      unknown: errorCopy.describeErrorCode("a_code_nobody_knows"),
      unknownReason: errorCopy.describeCheckoutReason("a_reason_nobody_knows"),
    },
    messages: {
      installation: installationMessages,
      workspaces: workspaceMessages,
      workspaceFailures: [
        "email_not_allowed",
        "signup_closed",
        "not_available",
      ].map((code) => workspaceMessages.describeWorkspaceFailure(code)),
      reviewSettings: reviewSettingsMessages,
      reviewSettingsIssues: [
        "MODEL_MANAGED_BY_INSTANCE",
        "CATALOG_ENTRY_OWN_KEY_MODE",
      ].map((code) => reviewSettingsMessages.describeIssue("model", code)),
      transport: transportMessages,
      loginErrors: [
        "access_denied",
        "email_not_allowed",
        "state_mismatch",
        "nothing_known",
      ].map((code) => authLoginErrors.loginErrorMessage(code)),
      planUsage,
      configNotices: {
        constants: configNotices,
        admin: configNotices.describeConfigNotices(
          {
            githubApp: { configured: false, kind: "missing", variables: [] },
            llm: { warnings: [] },
          } as unknown as Parameters<
            typeof configNotices.describeConfigNotices
          >[0],
          "admin",
        ),
        adminWithVariables: configNotices.describeConfigNotices(
          {
            githubApp: {
              configured: false,
              kind: "invalid",
              variables: ["GITHUB_APP_ID"],
            },
            llm: { warnings: [] },
          } as unknown as Parameters<
            typeof configNotices.describeConfigNotices
          >[0],
          "admin",
        ),
      },
      enabling: enablingCopy.enablingNotice({
        workspaces: 3,
        ownKeyWorkspaces: 1,
      }),
    },
  };
}

function output() {
  const words = modelChoice.modelChoiceWords(getProductIdentity());
  return {
    productName: getProductIdentity().name,
    passwordReset: passwordResetMessage({
      product: getProductIdentity(),
      to: "ada@example.test",
      link: LINK,
      validForMinutes: 30,
    }),
    invitationAdmin: invitationMessage({
      product: getProductIdentity(),
      to: "ada@example.test",
      link: LINK,
      workspaceName: "Acme <Team>",
      inviterName: "Grace",
      role: "admin",
      validForDays: 7,
    }),
    invitationMember: invitationMessage({
      product: getProductIdentity(),
      to: "ada@example.test",
      link: LINK,
      workspaceName: "Acme",
      inviterName: "Grace",
      role: "member",
      validForDays: 7,
    }),
    verification: verificationMessage({
      product: getProductIdentity(),
      to: "ada@example.test",
      link: LINK,
      validForHours: 24,
    }),
    balanceLow: balanceMessage({
      product: getProductIdentity(),
      to: "ada@example.test",
      level: "low",
      workspaceName: "Acme",
      balanceText: "$1.20",
      link: LINK,
    }),
    balanceEmpty: balanceMessage({
      product: getProductIdentity(),
      to: "ada@example.test",
      level: "empty",
      workspaceName: "Acme",
      balanceText: "$0.00",
      link: LINK,
    }),
    balanceNegative: balanceMessage({
      product: getProductIdentity(),
      to: "ada@example.test",
      level: "negative",
      workspaceName: "Acme",
      balanceText: "-$0.40",
      link: LINK,
    }),
    testMail: testMessage(
      "ada@example.test",
      "https://reviews.example.test",
      getProductIdentity(),
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
    brand: renderToStaticMarkup(<Brand product={getProductIdentity()} />),
    brandCompact: renderToStaticMarkup(
      <Brand product={getProductIdentity()} compact />,
    ),
    productNameInText: renderToStaticMarkup(
      <ProductName product={getProductIdentity()} />,
    ),
    ...texts(),
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
