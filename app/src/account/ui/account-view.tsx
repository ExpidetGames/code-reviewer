// SPDX-License-Identifier: Apache-2.0

// The account page: who you are here, your address, and the GitHub account linked to your account. The hint
// about a placeholder address that could not be replaced (docs/decisions/0001-editions-setup-and-accounts.md,
// section 2.5) is shown here, and to the instance admin in the portal.
import { LinkPanel } from "../../github-config/ui/link-panel.tsx";
import {
  describeGithubOutcome,
  describeGithubOutcomeError,
} from "../../github-config/ui/messages.ts";
import { PageHeader } from "../../ui/page-header.tsx";
import type { AccountView } from "../load.ts";

export function AccountPageContent({
  name,
  account,
  githubSignInAvailable,
  outcome,
}: {
  name: string;
  account: AccountView;
  /** The GitHub App's user authorization is configured, so linking can work. */
  githubSignInAvailable: boolean;
  /** `?github=` and `?github_error=` of the page's address. */
  outcome: { ok: string | null; error: string | null };
}) {
  const success =
    outcome.ok === null ? null : describeGithubOutcome(outcome.ok);
  const failure =
    outcome.error === null ? null : describeGithubOutcomeError(outcome.error);
  return (
    <>
      <PageHeader title="Your account" description={`Signed in as ${name}.`} />
      {success !== null ? (
        <p role="status" className="alert alert-success">
          {success}
        </p>
      ) : null}
      {failure !== null ? (
        <p role="alert" className="alert alert-error">
          {failure}
        </p>
      ) : null}

      <section className="settings-section" aria-labelledby="email-heading">
        <h2 id="email-heading">Email address</h2>
        {account.placeholder ? (
          <p>
            Your address is a placeholder from the time before accounts existed.
            It is replaced by the verified email address of your GitHub account
            the next time you sign in with GitHub.
          </p>
        ) : (
          <p>
            <span className="mono">{account.email}</span>{" "}
            <span
              className={`badge ${account.verified ? "badge-active" : "badge-unavailable"}`}
            >
              {account.verified ? "Verified" : "Not verified"}
            </span>
          </p>
        )}
        {account.emailConflict !== null ? (
          <p role="note" className="alert alert-warning">
            <strong>Your GitHub address could not be used.</strong> GitHub
            reports <span className="mono">{account.emailConflict}</span> as
            your verified address, but another account here has it already.
            Nothing was taken over or merged, and your account keeps its
            placeholder address. Ask an admin of this instance to sort out which
            of the two accounts you use.
          </p>
        ) : null}
      </section>

      <section className="settings-section" aria-labelledby="github-heading">
        <h2 id="github-heading">GitHub</h2>
        {account.identity !== null ? (
          <p>
            Linked:{" "}
            <span className="mono">
              {account.identity.login === null
                ? account.identity.githubId
                : `@${account.identity.login}`}
            </span>
            . You can sign in with it.
          </p>
        ) : (
          <>
            <p className="muted">
              No GitHub account is linked, so you cannot sign in with GitHub.
            </p>
            <LinkPanel
              surface="account"
              available={githubSignInAvailable}
              unavailableReason="Signing in with GitHub is not set up on this instance."
            />
          </>
        )}
      </section>
    </>
  );
}
