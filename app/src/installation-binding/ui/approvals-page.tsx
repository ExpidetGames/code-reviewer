// SPDX-License-Identifier: Apache-2.0

// The Approvals page of the admin portal (docs/decisions/0001-editions-setup-and-accounts.md, sections 2.3 and
// 2.9): the requests to link an installation that wait for the instance admin, each with the evidence (who asked,
// which account the installation is on, whether the person's own token lists the installation, and what the
// read of their role in the organization gave), and the decisions made last. `ApprovalsPageContent` is pure
// markup over the requests; the buttons are in `ApprovalActions`. Everything from GitHub or from a person is
// text.
import type { UnclaimedInstallation } from "../../db/repositories/unclaimed-installations-repository.ts";
import { InstanceSyncButton } from "../../projects/ui/sync-button.tsx";
import { formatUtc } from "../../ui/format-time.ts";
import type { ApprovalsApi } from "./api.ts";
import { ApprovalActions } from "./approval-actions.tsx";
import {
  describeRoleDetail,
  REQUEST_STATUS_COPY,
  ROLE_RESULT_COPY,
} from "./messages.ts";
import type { InstallationLinkRequestView } from "../requests.ts";

function Evidence({ request }: { request: InstallationLinkRequestView }) {
  const { evidence } = request;
  const detail = describeRoleDetail(evidence.roleDetail);
  return (
    <dl className="run-facts" aria-label="Evidence">
      <div>
        <dt>Asked by</dt>
        <dd>
          {request.requesterName ?? "A user who is gone"}
          {request.requesterEmail !== null
            ? ` (${request.requesterEmail})`
            : ""}
          {request.requesterGithubLogin !== null
            ? `, GitHub account ${request.requesterGithubLogin}`
            : ""}
        </dd>
      </div>
      <div>
        <dt>For workspace</dt>
        <dd>{request.workspaceName}</dd>
      </div>
      <div>
        <dt>Installation on</dt>
        <dd>
          {request.accountLogin} (
          {request.accountType === "Organization"
            ? "organization"
            : request.accountType === "User"
              ? "personal account"
              : "account"}
          )
        </dd>
      </div>
      <div>
        <dt>Can their token use the installation?</dt>
        <dd>
          {evidence.tokenCanAccess === null
            ? "Not checked"
            : evidence.tokenCanAccess
              ? "Yes"
              : "No"}
        </dd>
      </div>
      <div>
        <dt>Their role in the account</dt>
        <dd>
          {ROLE_RESULT_COPY[evidence.roleResult]}
          {detail !== null ? ` (${detail})` : ""}
        </dd>
      </div>
    </dl>
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
      <section className="settings-section" aria-labelledby="pending-heading">
        <h2 id="pending-heading">Waiting for you</h2>
        {pending.length === 0 ? (
          <p className="muted">No request waits for a decision.</p>
        ) : (
          <ul
            className="member-list"
            aria-label="Requests waiting for a decision"
          >
            {pending.map((request) => (
              <li
                key={request.id}
                className="pending-row"
                data-request={request.id}
              >
                <div className="member-main">
                  <span className="member-name">{request.accountLogin}</span>
                  <span className="muted small">
                    Asked{" "}
                    <time dateTime={request.createdAt}>
                      {formatUtc(request.createdAt)}
                    </time>
                  </span>
                </div>
                <Evidence request={request} />
                <ApprovalActions
                  requestId={request.id}
                  accountLogin={request.accountLogin}
                  {...(api === undefined ? {} : { api })}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="settings-section" aria-labelledby="decided-heading">
        <h2 id="decided-heading">Decided</h2>
        {decided.length === 0 ? (
          <p className="muted">Nothing has been decided yet.</p>
        ) : (
          <ul className="member-list" aria-label="Decided requests">
            {decided.map((request) => (
              <li key={request.id} className="member-row">
                <div className="member-main">
                  <span className="member-name">{request.accountLogin}</span>
                  <span className="muted small">
                    For {request.workspaceName}
                    {request.decidedAt !== null ? (
                      <>
                        {", "}
                        <time dateTime={request.decidedAt}>
                          {formatUtc(request.decidedAt)}
                        </time>
                      </>
                    ) : null}
                  </span>
                </div>
                <div className="member-role">
                  <span className="badge">
                    {REQUEST_STATUS_COPY[request.status]}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="settings-section" aria-labelledby="unclaimed-heading">
        <h2 id="unclaimed-heading">Installations nobody has linked</h2>
        <p className="muted">
          Anybody may install the GitHub App. An installation gives a workspace
          its repositories only once an Owner or Admin of that workspace has
          connected it on the Connections page, so these have no repositories in
          the app. Reading the installations again from GitHub does not connect
          them either.
        </p>
        {unclaimed.length === 0 ? (
          <p className="muted">GitHub lists no installation that waits.</p>
        ) : (
          <ul
            className="member-list"
            aria-label="Installations nobody has linked"
          >
            {unclaimed.map((installation) => (
              <li key={installation.installationId} className="member-row">
                <div className="member-main">
                  <span className="member-name">
                    {installation.accountLogin}
                  </span>
                  <span className="muted small">
                    {installation.accountType === "Organization"
                      ? "Organization"
                      : installation.accountType === "User"
                        ? "Personal account"
                        : "Account"}
                    , first seen{" "}
                    <time dateTime={installation.firstSeenAt}>
                      {formatUtc(installation.firstSeenAt)}
                    </time>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
        <InstanceSyncButton />
      </section>
    </>
  );
}
