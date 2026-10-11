// SPDX-License-Identifier: Apache-2.0

// The copy for what the admin data route answers: one sentence per stable code (src/admin/errors.ts) and
// for the fields of the forms. The codes are the contract, these sentences are only what the page shows.
import {
  describeTransportFailure,
  GENERIC_FAILURE,
} from "../../ui/transport-messages.ts";
import type { RequestIssue } from "../../ui/json-request.ts";

const FAILURE_COPY: Record<string, string> = {
  cross_site_request: "The request did not come from this page. Reload it.",
  too_many_workspaces:
    "This instance has more than one workspace, so it cannot become single-tenant. Remove the extra workspaces first.",
  at_least_one_method:
    "At least one way to sign in has to stay on, or nobody could sign in.",
  github_not_configured:
    "GitHub sign-in cannot be switched on before GitHub is configured.",
  admin_needs_github_identity:
    "Before GitHub is the only way to sign in, link your own GitHub account to your admin account, and make sure it is allowed to sign in. Otherwise you could not sign in afterwards.",
  invalid_input: "Some of the values are not valid. Check the fields.",
  rate_limited:
    "Too many test mails in a short time. Wait a few minutes and try again.",
  unavailable: "This is not available right now. Please try again later.",
};

/** The sentence for a failed change. `count` is the number of workspaces for `too_many_workspaces`. */
export function describeAdminFailure(code: string, count?: number): string {
  if (code === "too_many_workspaces" && count !== undefined)
    return `This instance has ${String(count)} workspaces, so it cannot become single-tenant. Single-tenant allows one workspace at most; remove the others first.`;
  return (
    describeTransportFailure(code) ??
    (Object.hasOwn(FAILURE_COPY, code) ? FAILURE_COPY[code] : undefined) ??
    GENERIC_FAILURE
  );
}

/** The sentence for a problem with one field. */
export function describeAdminIssue(issue: RequestIssue): string {
  switch (issue.code) {
    case "entries_required":
      return "Enter at least one entry.";
    case "entry_invalid":
      return "One of the entries is not valid. Emails look like name@example.com, domains like example.com.";
    case "too_many_entries":
      return "There are too many entries (500 at most).";
    case "number_out_of_range":
      return "Enter a whole number from 1 to 1000.";
    case "smtp_invalid":
    case "host_required":
      return "Enter the host name or address of the mail server.";
    case "host_invalid":
      return "This is not a host name or an IP address. Enter only the host, for example smtp.example.com, without a port or a scheme.";
    case "port_invalid":
      return "Enter a port from 1 to 65535.";
    case "port_not_allowed":
      return "Below 1024 only the ports of mail are allowed: 25, 465 and 587.";
    case "security_invalid":
      return "Choose how the connection is secured.";
    case "user_invalid":
      return "The user name contains a character that is not allowed (line breaks and control characters are not).";
    case "password_invalid":
      return "The password contains a line break or another control character. Paste it again without one.";
    case "password_too_long":
      return "The password is longer than 1024 characters.";
    case "password_conflict":
      return "Enter a new password or remove the saved one, not both.";
    case "password_required":
      return "Enter the password of this login. There is none saved, or the saved one cannot be read.";
    case "user_required":
      return "A password needs a user. Enter the user name, or leave the password empty.";
    case "clear_password_invalid":
    case "allow_self_signed_invalid":
      return GENERIC_FAILURE;
    case "sender_required":
      return "Enter the address the mail is sent from.";
    case "sender_invalid":
      return "This is not a valid sender address. It looks like name@example.com.";
    case "sender_name_invalid":
      return "The name is longer than 100 characters or contains a line break or another control character.";
    default:
      return GENERIC_FAILURE;
  }
}

/** The sentence for a class of failure of the test mail (smtp-failure.ts). The page shows the detail next to it. */
const TEST_MAIL_COPY: Record<string, string> = {
  not_configured: "There is no mail server saved yet. Save the settings first.",
  dns_failure:
    "The host name could not be found. Check the host name of the mail server.",
  connection_refused:
    "Nothing answered on that host and port. Check the host, the port and any firewall in between.",
  tls_error:
    "The secure connection to the mail server could not be set up.",
  auth_failed:
    "The mail server refused the login. Check the user name and the password.",
  sender_rejected: "The mail server does not accept the sender address.",
  recipient_rejected:
    "The mail server did not accept your own address as the recipient.",
  timeout:
    "The mail server did not answer in time. Check the host, the port and the security setting.",
  password_missing:
    "A login is set but there is no password saved. Enter the password and save.",
  password_unreadable:
    "The saved password cannot be read. Enter it again and save.",
  invalid_message: "Your own address cannot be used as a recipient.",
  unknown: "The test mail could not be sent.",
};

export function describeTestMailFailure(error: string): string {
  return (
    (Object.hasOwn(TEST_MAIL_COPY, error) ? TEST_MAIL_COPY[error] : undefined) ??
    TEST_MAIL_COPY.unknown ??
    GENERIC_FAILURE
  );
}
