// SPDX-License-Identifier: Apache-2.0

"use client";
// The one-time notice that the import of an existing installation leaves on the overview (#180,
// docs/decisions/0001-editions-setup-and-accounts.md, section 2.11, point 7): one line of summary with
// the details behind a disclosure (who did not become a member and why, the logins that never signed
// in, the allowed organization that is NOT migrated into a rule, what could not be imported — variable
// names only — and the OAuth app that is no longer used). The admin dismisses it.
import { Button } from "../../components/button.tsx";
import { HelpDisclosure } from "../../components/help-disclosure.tsx";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../../components/ui/alert.tsx";
import type { BlockReason } from "../../legacy-import/members.ts";
import type {
  ImportNotice as ImportNoticeValue,
  NotImportedGroup,
} from "../../legacy-import/notice.ts";
import type { AdminApi } from "./api.ts";
import { SaveResult, useSave } from "./use-save.tsx";

const REASON_COPY: Record<BlockReason, string> = {
  not_allowed: "was not on the list and not in the organization",
  login_bound_to_another_account:
    "has a login that is on the list, but it belongs to another GitHub account",
  login_ambiguous:
    "has a login that is on the list, but two accounts of this installation hold it, so neither was made a member",
  check_failed:
    "could not be checked against the organization (GitHub did not answer, or the stored sign-in cannot be read)",
};

const GROUP_COPY: Record<NotImportedGroup, string> = {
  github_app:
    "The GitHub App was not imported. Enter it under Integrations (the one-click setup or the manual form).",
  llm_key:
    "The LLM key was not imported. Enter it in the settings of the workspace, under LLM.",
  allowed_organization:
    "The allowed organization could not be read, so no member was admitted through it.",
};

function more(total: number, shown: number) {
  return total > shown ? ` and ${String(total - shown)} more` : "";
}

export function ImportNotice({
  notice,
  api,
}: {
  notice: ImportNoticeValue;
  /** Only tests pass this. */
  api?: AdminApi;
}) {
  const { pending, status, save } = useSave(api);
  return (
    <Alert
      variant="warning"
      role="note"
      aria-labelledby="import-notice-heading"
    >
      <AlertTitle id="import-notice-heading">
        This installation was updated
      </AlertTitle>
      <AlertDescription>
        <p>Your data and settings were imported into the default workspace.</p>
        <HelpDisclosure label="Details">
          <p className="pb-2">
            {String(notice.memberCount)}{" "}
            {notice.memberCount === 1 ? "person is" : "people are"} a member of
            it. Signing in is by email and password until you enable sign-in
            with GitHub under Integrations; people who used GitHub before then
            sign in with it again and are recognised.
          </p>
          <ul className="flex flex-col gap-1">
            {notice.notMembers.length > 0 ? (
              <li>
                <strong>Not made members:</strong>{" "}
                {notice.notMembers.map((entry, index) => (
                  <span key={`${entry.login ?? "unknown"}-${String(index)}`}>
                    {index > 0 ? "; " : ""}
                    {entry.login ?? "an account"} {REASON_COPY[entry.reason]}
                  </span>
                ))}
                {more(notice.notMembersTotal, notice.notMembers.length)}. They
                can be invited by email.
              </li>
            ) : null}
            {notice.neverSignedIn.length > 0 ? (
              <li>
                <strong>Allowed logins that never signed in:</strong>{" "}
                {notice.neverSignedIn.join(", ")}
                {more(notice.neverSignedInTotal, notice.neverSignedIn.length)}.
                Invite them by email from the workspace&apos;s members page.
              </li>
            ) : null}
            {notice.organization !== null ? (
              <li>
                <strong>
                  The allowed GitHub organization is not migrated.
                </strong>{" "}
                There is no sign-up rule for an organization. Members of{" "}
                {notice.organization} who passed the check are members now;
                others can only sign up again when you recreate that access as
                an email list or as allowed domains (Setup).
              </li>
            ) : null}
            {notice.notImported.map((entry) => (
              <li key={entry.group}>
                <strong>Not imported:</strong> {GROUP_COPY[entry.group]}{" "}
                {entry.variables.length > 0
                  ? `Variables: ${entry.variables.join(", ")}.`
                  : null}
              </li>
            ))}
            {notice.oauthApp ? (
              <li>
                <strong>The GitHub OAuth app is no longer used.</strong>{" "}
                GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET are not
                imported. Sign-in with GitHub uses the client id and secret of
                the GitHub App (Integrations).
              </li>
            ) : null}
            {notice.invalidLoginEntries > 0 ? (
              <li>
                <strong>
                  {String(notice.invalidLoginEntries)} entries of the list of
                  allowed logins were not valid
                </strong>{" "}
                and admitted nobody.
              </li>
            ) : null}
          </ul>
        </HelpDisclosure>
        <div className="flex items-center gap-3 pt-1">
          <Button
            variant="secondary"
            size="sm"
            type="button"
            disabled={pending}
            onClick={() => void save({ importNotice: { dismiss: true } })}
          >
            {pending ? "Hiding..." : "Hide this notice"}
          </Button>
          <SaveResult status={status} />
        </div>
      </AlertDescription>
    </Alert>
  );
}
