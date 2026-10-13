// SPDX-License-Identifier: Apache-2.0

// The Approvals page of the admin portal (#183, docs/decisions/0001-editions-setup-and-accounts.md,
// sections 2.3 and 2.9): the requests to link an installation that wait for the instance admin, in
// three deep-linkable tabs — `Waiting (n)`, `Decided` and `Not linked` — with "Sync from GitHub" as
// the one page-header action. A waiting row carries Approve / Deny and the evidence (who asked, which
// account the installation is on, whether the person's own token lists the installation, and what the
// read of their role in the organization gave) behind a disclosure, closed by default; "Decided" is a
// quiet history list. The old page description and the essay above the sync button are gone.
// Everything from GitHub or from a person is text; long names truncate instead of widening the page.
import { Suspense } from "react";
import { Breadcrumbs } from "../../components/breadcrumbs.tsx";
import { DescriptionList } from "../../components/description-list.tsx";
import { HelpDisclosure } from "../../components/help-disclosure.tsx";
import { PageHeader } from "../../components/page-header.tsx";
import { QueryTabs } from "../../components/query-tabs.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../../components/ui/empty.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import type { UnclaimedInstallation } from "../../db/repositories/unclaimed-installations-repository.ts";
import { InstanceSyncButton } from "../../projects/ui/sync-button.tsx";
import { formatUtc } from "../../ui/format-time.ts";
import type { ApprovalsApi } from "./api.ts";
import { ApprovalActions } from "./approval-actions.tsx";
import {
  describeRoleDetail,
  REQUEST_STATUS_COPY,
  ROLE_RESULT_COPY,
  TOKEN_CAN_ACCESS_COPY,
} from "./messages.ts";
import type { InstallationLinkRequestView } from "../requests.ts";

const LIST_CLASS =
  "flex flex-col divide-y divide-border rounded-lg border border-border bg-card";
const ROW_CLASS = "flex flex-col gap-3 p-4";

/** The parenthetical after the account name of a waiting request. */
function accountTypeNote(accountType: string): string {
  if (accountType === "Organization") return "organization";
  if (accountType === "User") return "personal account";
  return "account";
}

/** The label an unlinked installation carries. */
function accountTypeLabel(accountType: string): string {
  if (accountType === "Organization") return "Organization";
  if (accountType === "User") return "Personal account";
  return "Account";
}

/**
 * The quiet badge variant of a decision (#183 review): approved is success, denied is warning and a
 * request that was connected in the meantime is neutral. The label stays the meaning either way.
 */
function decidedBadgeVariant(
  status: InstallationLinkRequestView["status"],
): "success" | "warning" | "neutral" {
  if (status === "approved") return "success";
  if (status === "denied") return "warning";
  return "neutral";
}

function Evidence({ request }: { request: InstallationLinkRequestView }) {
  const { evidence } = request;
  const detail = describeRoleDetail(evidence.roleDetail);
  const askedBy = request.requesterName ?? "A user who is gone";
  const email =
    request.requesterEmail === null ? "" : ` (${request.requesterEmail})`;
  const login =
    request.requesterGithubLogin === null
      ? ""
      : `, GitHub account ${request.requesterGithubLogin}`;
  return (
    <DescriptionList
      items={[
        { term: "Asked by", description: `${askedBy}${email}${login}` },
        { term: "For workspace", description: request.workspaceName },
        {
          term: "Installation on",
          description: `${request.accountLogin} (${accountTypeNote(
            request.accountType,
          )})`,
        },
        {
          term: "Can their token use the installation?",
          description:
            evidence.tokenCanAccess === null
              ? "Not checked"
              : evidence.tokenCanAccess
                ? TOKEN_CAN_ACCESS_COPY
                : "No",
        },
        {
          term: "Their role in the account",
          description: `${ROLE_RESULT_COPY[evidence.roleResult]}${
            detail === null ? "" : ` (${detail})`
          }`,
        },
      ]}
    />
  );
}

function EmptyTab({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <Empty className="border border-border bg-card">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function WaitingTab({
  pending,
  api,
}: {
  pending: InstallationLinkRequestView[];
  api?: ApprovalsApi;
}) {
  if (pending.length === 0)
    return (
      <EmptyTab
        title="No requests waiting"
        description="A request appears here when GitHub cannot check who owns the account."
      />
    );
  return (
    <ul aria-label="Requests waiting for a decision" className={LIST_CLASS}>
      {pending.map((request) => (
        <li key={request.id} data-request={request.id} className={ROW_CLASS}>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className="min-w-0 truncate font-medium text-foreground">
              {request.accountLogin}
            </span>
            <span className="text-sm text-muted-foreground">
              Asked{" "}
              <time dateTime={request.createdAt}>
                {formatUtc(request.createdAt)}
              </time>
            </span>
          </div>
          <ApprovalActions
            requestId={request.id}
            accountLogin={request.accountLogin}
            {...(api === undefined ? {} : { api })}
          />
          <HelpDisclosure
            label="Evidence"
            ariaLabel={`Evidence for ${request.accountLogin}`}
          >
            <Evidence request={request} />
          </HelpDisclosure>
        </li>
      ))}
    </ul>
  );
}

function DecidedTab({ decided }: { decided: InstallationLinkRequestView[] }) {
  if (decided.length === 0)
    return (
      <EmptyTab
        title="Nothing decided yet"
        description="Approved and denied requests are listed here."
      />
    );
  return (
    <ul aria-label="Decided requests" className={LIST_CLASS}>
      {decided.map((request) => (
        <li
          key={request.id}
          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 p-4"
        >
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-foreground">
              {request.accountLogin}
            </span>
            <span className="text-sm text-muted-foreground">
              For {request.workspaceName}
              {request.decidedAt === null ? null : (
                <>
                  {", "}
                  <time dateTime={request.decidedAt}>
                    {formatUtc(request.decidedAt)}
                  </time>
                </>
              )}
            </span>
          </div>
          <Badge variant={decidedBadgeVariant(request.status)}>
            {REQUEST_STATUS_COPY[request.status]}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

function NotLinkedTab({ unclaimed }: { unclaimed: UnclaimedInstallation[] }) {
  return (
    <div className="flex flex-col gap-4">
      <HelpDisclosure label="What an unlinked installation is">
        <p>
          Anybody may install the GitHub App. An installation gives a workspace
          its repositories only once an Owner or Admin of that workspace has
          connected it on the Connections page, so these have no repositories in
          the app. Reading the installations again from GitHub does not connect
          them either.
        </p>
      </HelpDisclosure>
      {unclaimed.length === 0 ? (
        <EmptyTab
          title="Nothing unlinked"
          description="GitHub lists no installation that waits."
        />
      ) : (
        <ul aria-label="Installations nobody has linked" className={LIST_CLASS}>
          {unclaimed.map((installation) => (
            <li
              key={installation.installationId}
              className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 p-4"
            >
              <span className="min-w-0 truncate font-medium text-foreground">
                {installation.accountLogin}
              </span>
              <span className="text-sm text-muted-foreground">
                {accountTypeLabel(installation.accountType)}, first seen{" "}
                <time dateTime={installation.firstSeenAt}>
                  {formatUtc(installation.firstSeenAt)}
                </time>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ApprovalsPageContent({
  pending,
  decided,
  unclaimed = [],
  api,
}: {
  pending: InstallationLinkRequestView[];
  decided: InstallationLinkRequestView[];
  /** The installations of the App that no workspace has linked. */
  unclaimed?: UnclaimedInstallation[];
  /** Only tests pass this: a server component cannot hand functions to the client buttons. */
  api?: ApprovalsApi;
}) {
  return (
    <>
      <PageHeader
        title="Approvals"
        breadcrumb={
          <Breadcrumbs
            items={[{ label: "Admin", href: "/admin" }, { label: "Approvals" }]}
          />
        }
        actions={<InstanceSyncButton />}
      />
      <div className="flex max-w-[64rem] flex-col gap-6 pt-6">
        <Suspense
          fallback={
            <div role="status" aria-live="polite" aria-busy="true">
              <Skeleton className="h-11 w-64" aria-hidden="true" />
              <span className="sr-only">Loading the request states</span>
            </div>
          }
        >
          <QueryTabs
            aria-label="Request states"
            items={[
              {
                value: "waiting",
                label: `Waiting (${String(pending.length)})`,
                content: (
                  <WaitingTab
                    pending={pending}
                    {...(api === undefined ? {} : { api })}
                  />
                ),
              },
              {
                value: "decided",
                label: "Decided",
                content: <DecidedTab decided={decided} />,
              },
              {
                value: "not-linked",
                label: "Not linked",
                content: <NotLinkedTab unclaimed={unclaimed} />,
              },
            ]}
          />
        </Suspense>
      </div>
    </>
  );
}
