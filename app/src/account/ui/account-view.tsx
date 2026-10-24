// SPDX-License-Identifier: LicenseRef-Proprietary

// The account page: who you are here, your address, and the GitHub account linked to your account
// (#179). Exactly two cards, Email and GitHub, each with one status badge and one line; the long
// explanations (the placeholder address, the conflict of an imported user, the merge of two accounts)
// sit behind a disclosure. The hint about a placeholder address that could not be replaced
// (docs/decisions/0001-editions-setup-and-accounts.md, section 2.5) is shown here, and to the instance
// admin in the portal.
import { HelpDisclosure } from "../../components/help-disclosure.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import { PageHeader } from "../../components/page-header.tsx";
import { LinkPanel } from "../../github-config/ui/link-panel.tsx";
import {
  describeGithubOutcome,
  describeGithubOutcomeError,
} from "../../github-config/ui/messages.ts";
import type { AccountView } from "../load.ts";

function emailBadge(account: AccountView): {
  variant: "neutral" | "warning" | "success";
  text: string;
} {
  if (account.placeholder)
    return {
      variant: account.emailConflict === null ? "neutral" : "warning",
      text: "Placeholder",
    };
  return account.verified
    ? { variant: "success", text: "Verified" }
    : { variant: "neutral", text: "Not verified" };
}

function EmailCard({ account }: { account: AccountView }) {
  const badge = emailBadge(account);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Email</CardTitle>
        <CardAction>
          <Badge variant={badge.variant}>{badge.text}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="font-mono text-sm break-all">{account.email}</p>
        {account.emailConflict !== null ? (
          <HelpDisclosure label="Why your GitHub address could not be used">
            GitHub reports{" "}
            <span className="font-mono">{account.emailConflict}</span> as your
            verified address, but another account here has it already. Nothing
            was taken over or merged, and your account keeps its placeholder
            address. Ask an admin to sort out which of the two accounts you use.
          </HelpDisclosure>
        ) : account.placeholder ? (
          <HelpDisclosure label="Where this address comes from">
            It is the placeholder address of an imported account, replaced by
            your verified GitHub address the next time you sign in with GitHub.
          </HelpDisclosure>
        ) : null}
      </CardContent>
    </Card>
  );
}

function GithubCard({
  account,
  githubSignInAvailable,
  isInstanceAdmin,
}: {
  account: AccountView;
  githubSignInAvailable: boolean;
  isInstanceAdmin: boolean;
}) {
  const identity = account.identity;
  return (
    <Card>
      <CardHeader>
        <CardTitle>GitHub</CardTitle>
        <CardAction>
          <Badge variant={identity === null ? "neutral" : "success"}>
            {identity === null ? "Not linked" : "Linked"}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {identity === null ? (
          <LinkPanel
            available={githubSignInAvailable}
            unavailableReason="Signing in with GitHub is not set up here."
            merge={isInstanceAdmin && githubSignInAvailable}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Linked as{" "}
            <span className="font-mono">
              {identity.login === null
                ? identity.githubId
                : `@${identity.login}`}
            </span>
            . You can sign in with it.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function AccountPageContent({
  name,
  account,
  githubSignInAvailable,
  isInstanceAdmin = false,
  outcome,
}: {
  name: string;
  account: AccountView;
  /** The GitHub App's user authorization is configured, so linking can work. */
  githubSignInAvailable: boolean;
  /** Whether the person runs this instance; only then, and while GitHub sign-in works, can linking merge. */
  isInstanceAdmin?: boolean;
  /** `?github=` and `?github_error=` of the page's address. */
  outcome: { ok: string | null; error: string | null };
}) {
  const success =
    outcome.ok === null ? null : describeGithubOutcome(outcome.ok);
  const failure =
    outcome.error === null ? null : describeGithubOutcomeError(outcome.error);
  return (
    <>
      <PageHeader title="Account" description={`Signed in as ${name}.`} />
      <div className="flex flex-col gap-6">
        {success !== null ? (
          <Alert variant="success" role="status">
            <AlertDescription>{success}</AlertDescription>
          </Alert>
        ) : null}
        {failure !== null ? (
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        ) : null}
        <EmailCard account={account} />
        <GithubCard
          account={account}
          githubSignInAvailable={githubSignInAvailable}
          isInstanceAdmin={isInstanceAdmin}
        />
      </div>
    </>
  );
}
