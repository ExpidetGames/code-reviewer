// SPDX-License-Identifier: Apache-2.0

// The GitHub tile of the admin portal's Integrations page (docs/decisions/0001-editions-setup-and-accounts.md,
// section 2.4): its status, the addresses to enter at GitHub, the two ways to configure it, the prompts for an
// App that was imported or made without the user authorization, what an App may lack, and the admin's own
// GitHub account. Server rendered; the forms are client components.
import { PageHeader } from "../../ui/page-header.tsx";
import type { GithubIdentityView, EmailConflictView } from "../facts.ts";
import type { GithubConfigView } from "../service.ts";
import { ManifestForm } from "./manifest-form.tsx";
import { ManualForm } from "./manual-form.tsx";
import { PermissionsCheck } from "./permissions-check.tsx";
import { LinkPanel } from "./link-panel.tsx";
import {
  describeGithubOutcome,
  describeGithubOutcomeError,
} from "./messages.ts";
import { PrivateAppForm, UserAuthorizationForm } from "./prompt-forms.tsx";

export type GithubSectionProps = {
  view: GithubConfigView;
  tenancy: "single" | "multi";
  /** The name the one-click form starts with. */
  suggestedName: string;
  /** The admin's own GitHub account, if linked. */
  identity: GithubIdentityView | null;
  conflicts: EmailConflictView[];
  /** `?github=` and `?github_error=` of the page's address: what the last round trip came back with. */
  outcome: { ok: string | null; error: string | null };
};

const STATUS_BADGE = {
  configured: { className: "badge-active", text: "Configured" },
  problem: { className: "badge-unavailable", text: "Problem" },
  not_configured: { className: "", text: "Not configured" },
} as const;

function Addresses({ view }: { view: GithubConfigView }) {
  return (
    <details>
      <summary>Addresses to enter on GitHub</summary>
      <dl className="status-list">
        <div>
          <dt>Homepage URL</dt>
          <dd className="mono">{view.urls.homepage}</dd>
        </div>
        <div>
          <dt>Webhook URL</dt>
          <dd className="mono">{view.urls.webhook}</dd>
        </div>
        <div>
          <dt>Callback URL</dt>
          <dd className="mono">{view.urls.callback}</dd>
        </div>
        <div>
          <dt>Setup URL</dt>
          <dd className="mono">{view.urls.setup}</dd>
        </div>
      </dl>
    </details>
  );
}

export function GithubSection({
  view,
  tenancy,
  suggestedName,
  identity,
  conflicts,
  outcome,
}: GithubSectionProps) {
  const badge = STATUS_BADGE[view.status];
  const success =
    outcome.ok === null ? null : describeGithubOutcome(outcome.ok);
  const failure =
    outcome.error === null ? null : describeGithubOutcomeError(outcome.error);
  const saved = view.source === "database";
  const signInReady = view.userAuthorization.configured;
  return (
    <>
      <PageHeader
        title="Integrations"
        description="The services this instance works with."
      />
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

      <section className="settings-section" aria-labelledby="github-heading">
        <h2 id="github-heading">
          GitHub{" "}
          <span className={`badge ${badge.className}`}>{badge.text}</span>
        </h2>
        <p className="muted">
          One GitHub App signs people in and reviews pull requests. It is
          created here, in the browser, or entered by hand.
        </p>
        {view.status === "configured" && view.app !== null ? (
          <dl className="status-list">
            <div>
              <dt>App</dt>
              <dd>
                <span className="mono">{view.app.slug}</span>
                {view.app.installUrl !== null ? (
                  <>
                    {" "}
                    (<a href={view.app.installUrl}>install it on GitHub</a>)
                  </>
                ) : null}
              </dd>
            </div>
            <div>
              <dt>Where it came from</dt>
              <dd>
                {view.app.origin === "manifest"
                  ? "Created from this page."
                  : view.app.origin === "manual"
                    ? "Entered by hand."
                    : view.app.origin === "import"
                      ? "Imported from the environment of an earlier version."
                      : "Environment variables of an earlier version, not yet imported. Reviews work; to manage the App here, enter it in the form below."}
              </dd>
            </div>
            <div>
              <dt>Sign in with GitHub</dt>
              <dd>
                {signInReady
                  ? "Enabled."
                  : "Not enabled yet: the client id and secret of the App are missing."}
              </dd>
            </div>
            <div>
              <dt>Only on its own account</dt>
              <dd>
                {view.app.privateApp === null
                  ? "Not known yet."
                  : view.app.privateApp
                    ? "Yes: only the account that owns the App can install it."
                    : "No: any account can install it."}
              </dd>
            </div>
          </dl>
        ) : null}
        {view.status === "problem" && view.problem !== null ? (
          <p role="alert" className="alert alert-error">
            <strong>
              The GitHub App settings are{" "}
              {view.problem.kind === "missing" ? "incomplete" : "not usable"}:
            </strong>{" "}
            <span className="mono">{view.problem.fields.join(", ")}</span>.
            {view.source === "database"
              ? " A stored secret that cannot be read was saved with another APP_SECRET, or was changed. Enter it again in the form below."
              : " Fix the variables, or enter the App in the form below."}{" "}
            Reviews and sign in stay off until this is fixed.
          </p>
        ) : null}
        {view.status === "not_configured" ? (
          <p className="muted">
            Not connected yet. Reviews need the GitHub App, and so does the sign
            in with GitHub.
          </p>
        ) : null}
        {tenancy === "multi" && !signInReady ? (
          <p role="note" className="alert alert-warning">
            <strong>&quot;Connect GitHub&quot; is unavailable.</strong> On a
            multi-tenant instance workspaces connect their installations with
            the user authorization of the App, and its client id and secret are
            not configured. Until they are, no workspace can connect GitHub.
          </p>
        ) : null}
        <Addresses view={view} />
      </section>

      {saved && view.app !== null && !signInReady ? (
        <section className="settings-section">
          <UserAuthorizationForm view={view} />
        </section>
      ) : null}
      {saved && view.privateAppUnknown ? (
        <section className="settings-section">
          <PrivateAppForm />
        </section>
      ) : null}
      {view.status !== "not_configured" && view.mayLackPermissions ? (
        <section className="settings-section">
          <PermissionsCheck />
        </section>
      ) : null}

      <section className="settings-section">
        <ManifestForm
          suggestedName={suggestedName}
          configured={view.source !== "none"}
          tenancy={tenancy}
        />
      </section>
      <section className="settings-section">
        <ManualForm view={view} />
      </section>

      <section className="settings-section" aria-labelledby="identity-heading">
        <h2 id="identity-heading">Your GitHub account</h2>
        {identity !== null ? (
          <p>
            Linked:{" "}
            <span className="mono">
              {identity.login === null
                ? identity.githubId
                : `@${identity.login}`}
            </span>
            . You can switch sign-in to GitHub only (Setup).
          </p>
        ) : (
          <>
            <p className="muted">
              Not linked. Link it before you make GitHub the only way to sign
              in, or you could not sign in afterwards.
            </p>
            <LinkPanel
              surface="admin"
              available={signInReady}
              unavailableReason="Enable sign-in with GitHub first (the client id and secret of the App)."
              merge
            />
          </>
        )}
      </section>

      {conflicts.length > 0 ? (
        <section
          className="settings-section"
          aria-labelledby="conflict-heading"
        >
          <h2 id="conflict-heading">Addresses that could not be updated</h2>
          <p role="note" className="alert alert-warning">
            At their last GitHub sign in, GitHub reported a verified email
            address that another account here already has, so these users keep
            the placeholder address and nothing was merged. They see a hint on
            their account page. Ask them to sort out which account they use.
          </p>
          <ul>
            {conflicts.map((entry) => (
              <li key={entry.userId}>
                {entry.name}
                {entry.login === null ? "" : ` (@${entry.login})`}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
