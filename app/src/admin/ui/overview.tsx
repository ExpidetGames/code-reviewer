// SPDX-License-Identifier: Apache-2.0

// The overview of the portal: a checklist of what the instance needs (a mail server, GitHub), what it is
// set to (tenancy, sign-up rule, ways to sign in), and the notices that matter now: a sign-up rule that
// cannot work yet, and stored credentials that cannot be read any more.
import Link from "next/link";
import type { ReactNode } from "react";
import type { GithubConfigView } from "../../github-config/service.ts";
import type { AdminSettingsView } from "../service.ts";
import { FailClosedNotice } from "./notices.tsx";

function describeRule(rule: AdminSettingsView["signUpRule"]["value"]): string {
  if (rule.kind === "everyone") return "Everyone may sign up.";
  const count = rule.entries.length;
  const noun =
    rule.kind === "emails"
      ? count === 1
        ? "email address"
        : "email addresses"
      : count === 1
        ? "domain"
        : "domains";
  return `Only ${String(count)} listed ${noun}.`;
}

function describeMethods(methods: { emailPassword: boolean; github: boolean }) {
  if (methods.emailPassword && methods.github)
    return "Email with password and GitHub.";
  return methods.github ? "GitHub only." : "Email with password only.";
}

function Item({
  done,
  title,
  children,
}: {
  done: boolean | null;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="checklist-item">
      <span
        className={`badge ${done === true ? "badge-active" : done === false ? "badge-unavailable" : ""}`}
      >
        {done === true ? "Done" : done === false ? "To do" : "Setting"}
      </span>
      <div>
        <strong>{title}</strong>
        <p className="muted">{children}</p>
      </div>
    </li>
  );
}

function describeGithub(
  github: GithubConfigView | undefined,
  signInConfigured: boolean,
): { done: boolean; text: ReactNode } {
  const integrations = <Link href="/admin/integrations">Integrations</Link>;
  if (github === undefined || github.status === "not_configured")
    return {
      done: false,
      text: (
        <>
          Not configured. Reviews and the sign in with GitHub need the GitHub
          App. {integrations}
        </>
      ),
    };
  if (github.status === "problem")
    return {
      done: false,
      text: (
        <>
          The GitHub App settings are not usable
          {github.problem === null
            ? ""
            : `: ${github.problem.fields.join(", ")}`}
          . Reviews and the sign in stay off until this is fixed. {integrations}
        </>
      ),
    };
  return {
    done: true,
    text: (
      <>
        The GitHub App {github.app?.slug ?? ""} is configured.{" "}
        {signInConfigured
          ? "Signing in with GitHub is enabled."
          : "Signing in with GitHub is not enabled yet: the client id and secret of the App are missing."}{" "}
        {integrations}
      </>
    ),
  };
}

export function Overview({
  settings,
  github,
  emailConflictCount = 0,
}: {
  settings: AdminSettingsView;
  /** The GitHub integration (src/github-config/); left out, the checklist asks nothing about it. */
  github?: GithubConfigView;
  /** Users whose placeholder address could not be replaced because another account has GitHub's address. */
  emailConflictCount?: number;
}) {
  const githubItem = describeGithub(github, settings.githubConfigured);
  const broken = settings.secrets.filter(
    (secret) => secret.state === "undecryptable",
  );
  return (
    <>
      {settings.signUpRuleState.failClosed ? <FailClosedNotice /> : null}
      {emailConflictCount > 0 ? (
        <p role="note" className="alert alert-warning">
          <strong>
            {emailConflictCount === 1
              ? "One user could not get their GitHub address."
              : `${String(emailConflictCount)} users could not get their GitHub address.`}
          </strong>{" "}
          The verified address of their GitHub account belongs to another
          account, so they keep the placeholder address and nothing was merged.{" "}
          <Link href="/admin/integrations">Integrations</Link>
        </p>
      ) : null}
      {broken.length > 0 ? (
        <p role="alert" className="alert alert-error">
          <strong>
            {broken.length === 1
              ? "A stored credential cannot be read."
              : `${String(broken.length)} stored credentials cannot be read.`}
          </strong>{" "}
          It was saved with another APP_SECRET, or the stored value was changed.
          Enter it again where it belongs; if you changed APP_SECRET by mistake,
          restore the old value.
        </p>
      ) : null}
      <section className="settings-section" aria-labelledby="checklist-heading">
        <h2 id="checklist-heading">Checklist</h2>
        <ul className="checklist">
          <Item done={settings.mailConfigured} title="Mail server">
            {settings.mailConfigured ? (
              "A mail server is configured."
            ) : settings.smtp.value !== null ? (
              <>
                A mail server is saved, but no mail can be sent:{" "}
                {settings.smtp.password === "unreadable"
                  ? "the saved password cannot be read (it was saved with another APP_SECRET)."
                  : "the login has no password."}{" "}
                Until it is entered again, nothing that needs mail is offered
                (confirming addresses, resetting a password by mail).{" "}
                <Link href="/admin/mail">Mail</Link>
              </>
            ) : (
              <>
                Not configured. Without it nobody can verify an email address or
                reset a password by mail. <Link href="/admin/mail">Mail</Link>
              </>
            )}
          </Item>
          <Item done={githubItem.done} title="GitHub">
            {githubItem.text}
          </Item>
          <Item done={null} title="Tenancy">
            {settings.tenancy.value === "single"
              ? "Single-tenant: one workspace for the whole instance."
              : "Multi-tenant: users create workspaces."}{" "}
            {String(settings.workspaceCount)}{" "}
            {settings.workspaceCount === 1 ? "workspace" : "workspaces"} now.{" "}
            <Link href="/admin/setup">Setup</Link>
          </Item>
          <Item done={null} title="Sign-up rule">
            {describeRule(settings.signUpRule.value)}{" "}
            <Link href="/admin/setup">Setup</Link>
          </Item>
          <Item done={null} title="Ways to sign in">
            {describeMethods(settings.signInMethods.effective)}{" "}
            <Link href="/admin/setup">Setup</Link>
          </Item>
        </ul>
      </section>
    </>
  );
}
