// SPDX-License-Identifier: Apache-2.0

// The overview of the portal (#180): the screen's one "Needs attention" region first — stored
// credentials that cannot be read, a sign-up rule that cannot work yet, addresses that could not be
// merged — then the "Setup" card with one compact row per setting (a status icon, the value summary a
// person would see on its own page and a Configure link), then the import notice as a one-line banner.
// The old "Setting" badge and the page description are gone.
import Link from "next/link";
import { CheckCircle2, TriangleAlert } from "lucide-react";
import {
  NeedsAttention,
  type AttentionNotice,
} from "../../components/needs-attention.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import type { GithubConfigView } from "../../github-config/service.ts";
import { GITHUB_SIGN_IN_NOT_ENABLED } from "../../github-config/ui/messages.ts";
import { llmProviderDescriptors } from "../../llm/providers/index.ts";
import { UNREADABLE_SECRET_CAUSE } from "../../secrets/messages.ts";
import type { AdminSettingsView } from "../service.ts";
import { ImportNotice } from "./import-notice.tsx";
import { FAIL_CLOSED_TITLE, failClosedAttention } from "./notices.tsx";

type RowStatus = "ok" | "warn";

/** One compact setup row: a status icon, the setting, its value summary, a hint and a Configure link. */
function SetupRow({
  title,
  status,
  summary,
  hint,
  href,
}: {
  title: string;
  status: RowStatus;
  summary: string;
  hint?: string;
  /** Left out for a setting that has no page of its own (a read-only status). */
  href?: string;
}) {
  const Icon = status === "ok" ? CheckCircle2 : TriangleAlert;
  return (
    <li className="flex items-start gap-3 border-t border-border py-3 first:border-t-0">
      <Icon
        aria-hidden="true"
        className={`mt-0.5 size-4 shrink-0 ${
          status === "ok" ? "text-success" : "text-warning"
        }`}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium text-foreground">{title}</span>
          <span className="text-sm text-muted-foreground">{summary}</span>
        </div>
        {hint === undefined ? null : (
          <p className="text-sm text-muted-foreground">{hint}</p>
        )}
      </div>
      {href === undefined ? null : (
        <Link
          href={href}
          aria-label={`Configure ${title}`}
          className="shrink-0 rounded-sm text-sm font-medium text-primary underline-offset-4 hover:underline no-underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          Configure
        </Link>
      )}
    </li>
  );
}

function mailRow(settings: AdminSettingsView): {
  status: RowStatus;
  summary: string;
  hint?: string;
} {
  if (settings.mailConfigured) return { status: "ok", summary: "Configured" };
  if (settings.smtp.value !== null)
    return {
      status: "warn",
      summary: "Saved, cannot send",
      hint:
        settings.smtp.password === "unreadable"
          ? "The saved password cannot be read, so no mail can be sent."
          : "The saved login has no password, so no mail can be sent.",
    };
  return {
    status: "warn",
    summary: "Not configured",
    hint: "Nobody can verify an email address or reset a password by mail.",
  };
}

function operatorKeyRow(settings: AdminSettingsView): {
  status: RowStatus;
  summary: string;
  hint?: string;
} {
  // One entry for each provider, by its name (#427); a provider with no key is not a problem, only a saved key that
  // cannot be read is.
  const keys = Object.entries(settings.operatorLlmKeys);
  const describe = ([provider, key]: (typeof keys)[number]) => {
    const label = llmProviderDescriptors.labelOf(provider);
    if (key.state === "unreadable") return `${label}: Saved, cannot be read`;
    if (key.state === "not_configured") return `${label}: Not configured`;
    return key.lastFour === null
      ? `${label}: Configured`
      : `${label}: Configured (ending in ${key.lastFour})`;
  };
  const summary = keys.map(describe).join("; ");
  if (keys.some(([, key]) => key.state === "unreadable"))
    return {
      status: "warn",
      summary,
      hint: "Workspaces that use the key of the instance cannot run reviews on that provider until its key is entered again.",
    };
  if (keys.some(([, key]) => key.state === "configured"))
    return { status: "ok", summary };
  return {
    status: "ok",
    summary,
    hint: "Optional. Only workspaces that use the key of the instance need one.",
  };
}

function githubRow(
  github: GithubConfigView | undefined,
  signInConfigured: boolean,
): { status: RowStatus; summary: string; hint?: string } {
  if (github === undefined || github.status === "not_configured")
    return {
      status: "warn",
      summary: "Not configured",
      hint: "Reviews and signing in with GitHub need the GitHub App.",
    };
  if (github.status === "problem")
    return {
      status: "warn",
      summary: "Not usable",
      hint: `The settings are not usable${
        github.problem === null ? "" : `: ${github.problem.fields.join(", ")}`
      }.`,
    };
  return {
    status: "ok",
    summary:
      github.app?.slug === undefined
        ? "Configured"
        : `Configured (${github.app.slug})`,
    hint: signInConfigured
      ? "Signing in with GitHub is enabled."
      : GITHUB_SIGN_IN_NOT_ENABLED,
  };
}

function signUpRuleSummary(
  rule: AdminSettingsView["signUpRule"]["value"],
): string {
  if (rule.kind === "everyone") return "Everyone";
  return rule.kind === "emails"
    ? "Listed email addresses"
    : "Allowed email domains";
}

function signInMethodsSummary(methods: {
  emailPassword: boolean;
  github: boolean;
}): string {
  if (methods.emailPassword && methods.github) return "Email + GitHub";
  return methods.github ? "GitHub" : "Email";
}

function secretsNotice(count: number): AttentionNotice {
  return {
    id: "stored-credentials",
    severity: "error",
    title:
      count === 1
        ? "A stored credential cannot be read."
        : `${String(count)} stored credentials cannot be read.`,
    detail: (
      <>
        {UNREADABLE_SECRET_CAUSE} Enter it again under{" "}
        <Link href="/admin/integrations">Integrations</Link>,{" "}
        <Link href="/admin/mail">Mail</Link> or{" "}
        <Link href="/admin/llm">LLM key</Link>; if you changed APP_SECRET by
        mistake, restore the old value.
      </>
    ),
  };
}

function conflictNotice(count: number): AttentionNotice {
  return {
    id: "github-address-conflicts",
    severity: "warning",
    title:
      count === 1
        ? "One user could not get their GitHub address."
        : `${String(count)} users could not get their GitHub address.`,
    detail: (
      <>
        The verified address of their GitHub account belongs to another account,
        so they keep the placeholder address and nothing was merged.{" "}
        <Link href="/admin/integrations">Integrations</Link>
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
  const broken = settings.secrets.filter(
    (secret) => secret.state === "undecryptable",
  );
  // Status first (#180): the one attention region of the screen, at most three rows, each with a link
  // into the section that fixes it.
  const attention: AttentionNotice[] = [
    ...(broken.length > 0 ? [secretsNotice(broken.length)] : []),
    ...(settings.signUpRuleState.failClosed ? [failClosedAttention()] : []),
    ...(emailConflictCount > 0 ? [conflictNotice(emailConflictCount)] : []),
  ];
  const mail = mailRow(settings);
  const githubItem = githubRow(github, settings.githubConfigured);
  const operatorKey = operatorKeyRow(settings);
  return (
    <>
      <NeedsAttention notices={attention} maxRows={3} />
      <Card role="region" aria-labelledby="setup-heading">
        <CardHeader>
          <CardTitle>
            <h2
              id="setup-heading"
              className="text-lg font-semibold tracking-tight"
            >
              Setup
            </h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col">
            <SetupRow
              title="Mail server"
              status={mail.status}
              summary={mail.summary}
              {...(mail.hint === undefined ? {} : { hint: mail.hint })}
              href="/admin/mail"
            />
            <SetupRow
              title="GitHub"
              status={githubItem.status}
              summary={githubItem.summary}
              {...(githubItem.hint === undefined
                ? {}
                : { hint: githubItem.hint })}
              href="/admin/integrations"
            />
            <SetupRow
              title="LLM keys of the instance"
              status={operatorKey.status}
              summary={operatorKey.summary}
              {...(operatorKey.hint === undefined
                ? {}
                : { hint: operatorKey.hint })}
              href="/admin/llm"
            />
            <SetupRow
              title="Tenancy"
              status="ok"
              summary={
                settings.tenancy.value === "single"
                  ? "Single-tenant"
                  : "Multi-tenant"
              }
              hint={`${String(settings.workspaceCount)} ${
                settings.workspaceCount === 1 ? "workspace" : "workspaces"
              } now.`}
              href="/admin/setup/instance"
            />
            <SetupRow
              title="Sign-up rule"
              status={settings.signUpRuleState.failClosed ? "warn" : "ok"}
              summary={signUpRuleSummary(settings.signUpRule.value)}
              {...(settings.signUpRuleState.failClosed
                ? { hint: FAIL_CLOSED_TITLE }
                : {})}
              href="/admin/setup/sign-up"
            />
            <SetupRow
              title="Ways to sign in"
              status="ok"
              summary={signInMethodsSummary(settings.signInMethods.effective)}
              href="/admin/setup/sign-in"
            />
          </ul>
        </CardContent>
      </Card>
      {settings.importNotice !== null ? (
        <ImportNotice notice={settings.importNotice} />
      ) : null}
    </>
  );
}
