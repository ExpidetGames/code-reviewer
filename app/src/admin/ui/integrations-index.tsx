// SPDX-License-Identifier: Apache-2.0

// The Integrations index of the admin portal (#182): one status card per service the instance works
// with (GitHub App, Mail). Each card carries a status badge, one line and the link to the page that
// owns the service, so the index stays a directory and never stacks the forms of both services.
// Apache-2.0 (our own composition); the primitives it uses live under `components/ui/`.
import Link from "next/link";
import { Breadcrumbs } from "../../components/breadcrumbs.tsx";
import { PageHeader } from "../../components/page-header.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import type { GithubConfigView } from "../../github-config/service.ts";

/** What the Mail card reads of the admin settings: the state it shows, never a secret. */
export type MailStatus = {
  mailConfigured: boolean;
  smtp: { value: unknown; password: string };
};

export type IntegrationCard = {
  id: string;
  name: string;
  badge: { variant: "success" | "warning" | "neutral"; text: string };
  /** One line, the value a person would see on the service's own page. */
  summary: string;
  /** The page that owns the service. */
  href: string;
  /** The link's text, an action the person recognises. */
  actionLabel: string;
};

const GITHUB_HREF = "/admin/integrations/github";
const MAIL_HREF = "/admin/mail";

export function githubIntegrationCard(view: GithubConfigView): IntegrationCard {
  if (view.status === "configured")
    return {
      id: "github",
      name: "GitHub App",
      badge: { variant: "success", text: "Configured" },
      summary:
        view.app?.slug === null || view.app?.slug === undefined
          ? "Reviews and signing in with GitHub work."
          : `The App ${view.app.slug} reviews pull requests and signs people in.`,
      href: GITHUB_HREF,
      actionLabel: "Open GitHub App",
    };
  if (view.status === "problem")
    return {
      id: "github",
      name: "GitHub App",
      badge: { variant: "warning", text: "Problem" },
      summary:
        view.problem === null
          ? "The App settings are not usable."
          : `The App settings are not usable: ${view.problem.fields.join(", ")}.`,
      href: GITHUB_HREF,
      actionLabel: "Open GitHub App",
    };
  return {
    id: "github",
    name: "GitHub App",
    badge: { variant: "neutral", text: "Not configured" },
    summary: "Reviews and signing in with GitHub need the GitHub App.",
    href: GITHUB_HREF,
    actionLabel: "Open GitHub App",
  };
}

export function mailIntegrationCard(settings: MailStatus): IntegrationCard {
  if (settings.mailConfigured)
    return {
      id: "mail",
      name: "Mail",
      badge: { variant: "success", text: "Configured" },
      summary: "Email addresses can be verified and passwords reset by mail.",
      href: MAIL_HREF,
      actionLabel: "Open Mail",
    };
  if (settings.smtp.value !== null)
    return {
      id: "mail",
      name: "Mail",
      badge: { variant: "warning", text: "Problem" },
      summary:
        settings.smtp.password === "unreadable"
          ? "The saved password cannot be read, so no mail can be sent."
          : "The saved login has no password, so no mail can be sent.",
      href: MAIL_HREF,
      actionLabel: "Open Mail",
    };
  return {
    id: "mail",
    name: "Mail",
    badge: { variant: "neutral", text: "Not configured" },
    summary: "Nobody can verify an email address or reset a password by mail.",
    href: MAIL_HREF,
    actionLabel: "Open Mail",
  };
}

export function IntegrationsIndex({
  cards,
}: {
  cards: readonly IntegrationCard[];
}) {
  return (
    <>
      <PageHeader
        title="Integrations"
        breadcrumb={
          <Breadcrumbs
            items={[
              { label: "Admin", href: "/admin" },
              { label: "Integrations" },
            ]}
          />
        }
      />
      <div className="flex max-w-[64rem] flex-col gap-6 pt-6">
        {cards.map((card) => (
          <Card
            key={card.id}
            role="region"
            aria-labelledby={`integration-${card.id}-heading`}
          >
            <CardHeader>
              <CardTitle>
                <h2
                  id={`integration-${card.id}-heading`}
                  className="text-lg font-semibold tracking-tight"
                >
                  {card.name}
                </h2>
              </CardTitle>
              <CardAction>
                <Badge variant={card.badge.variant}>{card.badge.text}</Badge>
              </CardAction>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center justify-between gap-4">
              <p className="text-sm text-muted-foreground">{card.summary}</p>
              <Link
                href={card.href}
                className="shrink-0 rounded-sm text-sm font-medium text-primary underline-offset-4 hover:underline no-underline"
              >
                {card.actionLabel}
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
