// SPDX-License-Identifier: Apache-2.0

// The copy for what the setup answers: one sentence per stable code (src/setup/errors.ts), and for
// the fields of the wizard. The codes are the contract, these sentences are only what the page shows.
import {
  PASSWORD_ERROR_COPY,
  type PasswordErrorCode,
} from "../../auth/password-policy.ts";
import {
  CROSS_SITE_REQUEST,
  ENTRIES_REQUIRED,
  ENTRY_INVALID,
  INVALID_EMAIL,
  TOO_MANY_ENTRIES,
} from "../../copy/messages.ts";
import {
  describeTransportFailure,
  GENERIC_FAILURE,
} from "../../ui/transport-messages.ts";

/** Where the app runs decides how a person gets a new setup code. */
export type SetupHosting = "server" | "serverless";

const RESTART = "Restart the app: it prints a new code in its log.";
/** A serverless deployment prints nothing: the operator makes the code with a command (#321). */
const NEW_CODE = "Run pnpm setup-code in a terminal: it makes a new code.";

const FAILURE_COPY: Record<string, string> = {
  invalid_code:
    "That code is not correct. Copy it from the log of the app and try again. After 10 wrong codes this form locks until the app is restarted.",
  rate_limited:
    "Too many attempts in a short time. Wait a minute and try again.",
  setup_locked: `Too many wrong codes: the setup is locked. ${RESTART}`,
  code_expired: `This code is older than 60 minutes and no longer valid. ${RESTART}`,
  code_used: `This code was already used. ${RESTART}`,
  setup_unavailable: `This app has not printed a setup code. ${RESTART}`,
  setup_session_required: `Enter the setup code first. If you did, the session was lost: reload the page.`,
  setup_session_expired: `The setup session ended after 30 minutes. ${RESTART}`,
  already_set_up: "Setup is already done. Reload the page.",
  email_in_use: "An account with this email address exists already.",
  admin_unusable:
    "This email address or password cannot be used to sign in. Nothing was created: change them and try again.",
  cross_site_request: CROSS_SITE_REQUEST,
};

/** The sentences that differ in a serverless deployment: no log to read, no restart to make. */
const SERVERLESS_FAILURE_COPY: Record<string, string> = {
  invalid_code: `That code is not correct. Use the code that pnpm setup-code printed and try again. After 10 wrong codes this form locks until you make a new code with pnpm setup-code.`,
  setup_locked: `Too many wrong codes: the setup is locked. ${NEW_CODE}`,
  code_expired: `This code is older than 60 minutes and no longer valid. ${NEW_CODE}`,
  code_used: `This code was already used. ${NEW_CODE}`,
  setup_unavailable: `No setup code was made for this deployment yet. ${NEW_CODE}`,
  setup_session_expired: `The setup session ended after 30 minutes. ${NEW_CODE}`,
};

/** The sentence for a failed call of the code form or the wizard. */
export function describeSetupFailure(
  code: string,
  hosting: SetupHosting = "server",
): string {
  if (hosting === "serverless" && Object.hasOwn(SERVERLESS_FAILURE_COPY, code))
    return SERVERLESS_FAILURE_COPY[code] ?? GENERIC_FAILURE;
  return (
    describeTransportFailure(code) ??
    (Object.hasOwn(FAILURE_COPY, code) ? FAILURE_COPY[code] : undefined) ??
    GENERIC_FAILURE
  );
}

/** The sentence for a problem with one field of the wizard. */
export function describeSetupIssue(field: string, code: string): string {
  if (field === "admin.password" && Object.hasOwn(PASSWORD_ERROR_COPY, code))
    return PASSWORD_ERROR_COPY[code as PasswordErrorCode];
  switch (code) {
    case "email_invalid":
      return INVALID_EMAIL;
    case "tenancy_invalid":
      return "Choose single-tenant or multi-tenant.";
    case "sign_up_rule_invalid":
      return "Choose who may sign up.";
    case "entries_required":
      return ENTRIES_REQUIRED;
    case "entry_invalid":
      return field === "signUp.entries"
        ? ENTRY_INVALID
        : "This entry is not valid.";
    case "too_many_entries":
      return TOO_MANY_ENTRIES;
    default:
      return GENERIC_FAILURE;
  }
}

/**
 * The longer explanation behind the password field, shown in a HelpDisclosure (#169). The rule itself
 * is `PASSWORD_RULE_HINT` in `auth/password-policy.ts`; this only says why there are no other rules.
 */
export const PASSWORD_REASON =
  "There are no other rules: a long passphrase of a few unrelated words is the strongest choice. The same rule applies to every account here.";

/**
 * The one line under a rule that names emails or domains (#172). The shared warning
 * (`FAIL_CLOSED_WARNING`, #169) states the same in full and sits in the field's InfoHint; this line
 * only carries what the person has to know without opening it.
 */
export const FAIL_CLOSED_LINE =
  "Until addresses can be verified, nobody except you can sign up.";

/** The step of the wizard (1 to 3) a field belongs to, to show the problem where it can be fixed. */
export function stepOfField(field: string): 1 | 2 | 3 {
  if (field === "tenancy") return 1;
  if (field.startsWith("signUp")) return 2;
  return 3;
}
