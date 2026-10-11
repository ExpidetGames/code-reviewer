// The copy for what the setup answers: one sentence per stable code (src/setup/errors.ts), and for
// the fields of the wizard. The codes are the contract, these sentences are only what the page shows.
import {
  PASSWORD_ERROR_COPY,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type PasswordErrorCode,
} from "../../auth/password-policy.ts";
import {
  describeTransportFailure,
  GENERIC_FAILURE,
} from "../../ui/transport-messages.ts";

const RESTART = "Restart the app: it prints a new code in its log.";

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
  already_set_up: "This instance is already set up. Reload the page.",
  email_in_use: "An account with this email address exists already.",
  cross_site_request: "The request did not come from this page. Reload it.",
};

/** The sentence for a failed call of the code form or the wizard. */
export function describeSetupFailure(code: string): string {
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
      return "Enter a valid email address.";
    case "tenancy_invalid":
      return "Choose single-tenant or multi-tenant.";
    case "sign_up_rule_invalid":
      return "Choose who may sign up.";
    case "entries_required":
      return "Enter at least one entry.";
    case "entry_invalid":
      return field === "signUp.entries"
        ? "One of the entries is not valid. Emails look like name@example.com, domains like example.com."
        : "This entry is not valid.";
    case "too_many_entries":
      return "There are too many entries (500 at most).";
    default:
      return GENERIC_FAILURE;
  }
}

export const PASSWORD_REASON = `At least ${String(PASSWORD_MIN_LENGTH)} and at most ${String(PASSWORD_MAX_LENGTH)} characters, and not a common password. There are no other rules: a long passphrase of a few unrelated words is the strongest choice. The same rule applies to every account on this instance.`;

/** The step of the wizard (1 to 3) a field belongs to, to show the problem where it can be fixed. */
export function stepOfField(field: string): 1 | 2 | 3 {
  if (field === "tenancy") return 1;
  if (field.startsWith("signUp")) return 2;
  return 3;
}
