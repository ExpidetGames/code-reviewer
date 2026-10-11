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
    default:
      return GENERIC_FAILURE;
  }
}
