// SPDX-License-Identifier: Apache-2.0

// The GitHub App page of the admin portal (#182): the App's status with the addresses to enter on
// GitHub (shown directly, they are what the person came for), the two ways to connect it behind one
// segmented control, the sign in with GitHub, and the permissions of an App that may lack them behind
// a disclosure. The admin's own GitHub account lives on /account (#179), not here. Server rendered;
// the forms are client components.
import { Breadcrumbs } from "../../components/breadcrumbs.tsx";
import { DescriptionList } from "../../components/description-list.tsx";
import { HelpDisclosure } from "../../components/help-disclosure.tsx";
import { PageHeader } from "../../components/page-header.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import { UNREADABLE_SECRET_CAUSE } from "../../secrets/messages.ts";
import type { EmailConflictView } from "../facts.ts";
import type { GithubConfigView } from "../service.ts";
import { ConnectApp } from "./connect-app.tsx";
import {
  describeGithubOutcome,
  describeGithubOutcomeError,
  GITHUB_SIGN_IN_NOT_ENABLED,
} from "./messages.ts";
import { PermissionsCheck } from "./permissions-check.tsx";
import { PrivateAppForm, UserAuthorizationForm } from "./prompt-forms.tsx";

export type GithubSectionProps = {
  view: GithubConfigView;
  tenancy: "single" | "multi";
  /** The name the one-click form starts with. */
  suggestedName: string;
  conflicts: EmailConflictView[];
  /** `?github=` and `?github_error=` of the page's address: what the last round trip came back with. */
  outcome: { ok: string | null; error: string | null };
};

const STATUS_BADGE = {
  configured: { variant: "success", text: "Configured" },
  problem: { variant: "warning", text: "Problem" },
  not_configured: { variant: "neutral", text: "Not configured" },
} as const;

function originText(app: GithubConfigView["app"]): string {
  switch (app?.origin) {
    case "manifest":
      return "Created from this page.";
    case "manual":
      return "Entered by hand.";
    case "import":
      return "Imported from the environment of an earlier version.";
    default:
      return "Environment variables of an earlier version, not yet imported. Reviews work; to manage the App here, enter it below.";
  }
}

function AddressList({ urls }: { urls: GithubConfigView["urls"] }) {
  return (
    <DescriptionList
      items={[
        {
          term: "Homepage URL",
          description: (
            <span className="font-mono break-all">{urls.homepage}</span>
          ),
        },
        {
          term: "Webhook URL",
          description: (
            <span className="font-mono break-all">{urls.webhook}</span>
          ),
        },
        {
          term: "Callback URL",
          description: (
            <span className="font-mono break-all">{urls.callback}</span>
          ),
        },
        {
          term: "Setup URL",
          description: (
            <span className="font-mono break-all">{urls.setup}</span>
          ),
        },
      ]}
    />
  );
}

/** The status card: the badge, the facts of the App and the addresses, all visible (#182-T03). */
export function GithubStatusCard({ view }: { view: GithubConfigView }) {
  const badge = STATUS_BADGE[view.status];
  const signInReady = view.userAuthorization.configured;
  const app = view.app;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Status</CardTitle>
        <CardAction>
          <Badge variant={badge.variant}>{badge.text}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {view.status === "configured" && app !== null ? (
          <DescriptionList
            items={[
              {
                term: "App",
                description: (
                  <>
                    <span className="font-mono">{app.slug}</span>
                    {app.appId === null ? null : (
                      <span className="text-muted-foreground">
                        {" "}
                        (id {app.appId})
                      </span>
                    )}
                  </>
                ),
              },
              { term: "Where it came from", description: originText(app) },
              {
                term: "Sign in with GitHub",
                description: signInReady ? (
                  <Badge variant="success">Enabled</Badge>
                ) : (
                  GITHUB_SIGN_IN_NOT_ENABLED
                ),
              },
              {
                term: "Only on its own account",
                description:
                  app.privateApp === null
                    ? "Not known yet."
                    : app.privateApp
                      ? "Yes: only the account that owns the App can install it."
                      : "No: any account can install it.",
              },
            ]}
          />
        ) : null}
        {view.status === "problem" && view.problem !== null ? (
          <Alert variant="destructive">
            <AlertDescription>
              <strong>
                The GitHub App settings are{" "}
                {view.problem.kind === "missing" ? "incomplete" : "not usable"}:
              </strong>{" "}
              <span className="font-mono">
                {view.problem.fields.join(", ")}
              </span>
              .{" "}
              {view.source === "database"
                ? `A stored secret that cannot be read. ${UNREADABLE_SECRET_CAUSE} Enter it again below.`
                : "Fix the variables, or enter the App below."}{" "}
              Reviews and sign in stay off until this is fixed.
            </AlertDescription>
          </Alert>
        ) : null}
        {view.status === "not_configured" ? (
          <p className="text-sm text-muted-foreground">
            Not connected yet. Reviews need the GitHub App, and so does the sign
            in with GitHub.
          </p>
        ) : null}
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-foreground">
            Addresses to enter on GitHub
          </h3>
          <AddressList urls={view.urls} />
        </div>
      </CardContent>
    </Card>
  );
}

/** "Sign in with GitHub": the form that turns it on while it is off, the state while it works. */
function SignInCard({ view }: { view: GithubConfigView }) {
  const signInReady = view.userAuthorization.configured;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in with GitHub</CardTitle>
        {signInReady ? (
          <CardAction>
            <Badge variant="success">Enabled</Badge>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        {signInReady ? (
          <p className="text-sm text-muted-foreground">
            People can sign in with GitHub. Your own GitHub account is linked on
            the Account page.
          </p>
        ) : (
          <UserAuthorizationForm view={view} />
        )}
      </CardContent>
    </Card>
  );
}

export function GithubSection({
  view,
  tenancy,
  suggestedName,
  conflicts,
  outcome,
}: GithubSectionProps) {
  const success =
    outcome.ok === null ? null : describeGithubOutcome(outcome.ok);
  const failure =
    outcome.error === null ? null : describeGithubOutcomeError(outcome.error);
  const saved = view.source === "database";
  const signInReady = view.userAuthorization.configured;
  return (
    <>
      <PageHeader
        title="GitHub App"
        breadcrumb={
          <Breadcrumbs
            items={[
              { label: "Admin", href: "/admin" },
              { label: "Integrations", href: "/admin/integrations" },
              { label: "GitHub App" },
            ]}
          />
        }
      />
      <div className="flex max-w-[44rem] flex-col gap-6 pt-6">
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

        <GithubStatusCard view={view} />

        {tenancy === "multi" && !signInReady ? (
          <Alert variant="warning" role="note">
            <AlertDescription>
              <strong>&quot;Connect GitHub&quot; is unavailable.</strong> On a
              multi-tenant instance workspaces connect their installations with
              the user authorization of the App, and its client id and secret
              are not configured. Until they are, no workspace can connect
              GitHub.
            </AlertDescription>
          </Alert>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Connect the App</CardTitle>
          </CardHeader>
          <CardContent>
            <ConnectApp
              view={view}
              suggestedName={suggestedName}
              tenancy={tenancy}
            />
          </CardContent>
        </Card>

        {saved && view.app !== null ? <SignInCard view={view} /> : null}

        {saved && view.privateAppUnknown ? (
          <Card>
            <CardHeader>
              <CardTitle>Where can this App be installed?</CardTitle>
            </CardHeader>
            <CardContent>
              <PrivateAppForm />
            </CardContent>
          </Card>
        ) : null}

        {view.status !== "not_configured" && view.mayLackPermissions ? (
          <HelpDisclosure label="Permissions GitHub granted">
            <PermissionsCheck />
          </HelpDisclosure>
        ) : null}

        {conflicts.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Addresses that could not be updated</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Alert variant="warning" role="note">
                <AlertDescription>
                  At their last GitHub sign in, GitHub reported a verified email
                  address that another account here already has, so these users
                  keep the placeholder address and nothing was merged. They see
                  a hint on their account page. Ask them to sort out which
                  account they use.
                </AlertDescription>
              </Alert>
              <ul className="list-disc pl-5 text-sm text-foreground">
                {conflicts.map((entry) => (
                  <li key={entry.userId}>
                    {entry.name}
                    {entry.login === null ? "" : ` (@${entry.login})`}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}
