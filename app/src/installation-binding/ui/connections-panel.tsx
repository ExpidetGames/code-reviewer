// SPDX-License-Identifier: Apache-2.0

"use client";
// The Connections page of a workspace: what a flow ended with, the connections with their state, the buttons
// that start the binding of an installation (Connect GitHub, Link an existing installation), the list to choose
// from, and the requests the instance admin decides. The buttons only show what the role allows; the routes
// and the services decide for themselves. Account names come from GitHub: text, never markup.
import { useRouter } from "next/navigation";
import { useId, useMemo, useState } from "react";
import { goTo } from "../../github-config/ui/api.ts";
import { Button } from "../../ui/button.tsx";
import { formatUtc } from "../../ui/format-time.ts";
import type { RequestResult } from "../../ui/json-request.ts";
import { browserBindingApi, type BindingApi } from "./api.ts";
import type {
  ConnectionsPageData,
  ConnectionView,
} from "./connections-page.tsx";
import {
  AVAILABILITY_COPY,
  describeBindingFailure,
  REQUEST_STATUS_COPY,
} from "./messages.ts";

const STATUS_COPY: Record<ConnectionView["status"], string> = {
  active: "Connected",
  disabled: "Suspended on GitHub",
  disconnected: "Disconnected",
};

export function ConnectionsPanel({
  workspaceSlug,
  canManage,
  data,
  api: apiProp,
  go = goTo,
}: {
  workspaceSlug: string;
  canManage: boolean;
  data: ConnectionsPageData;
  /** Only tests pass these. */
  api?: BindingApi;
  go?: (url: string) => void;
}) {
  const router = useRouter();
  const ids = useId();
  const defaultApi = useMemo(
    () => browserBindingApi(workspaceSlug),
    [workspaceSlug],
  );
  const api = apiProp ?? defaultApi;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  /** Starts a flow: the answer is the address of a page at GitHub, where the browser goes. */
  async function begin(
    call: () => Promise<RequestResult<{ ok: true; url: string }>>,
  ) {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const result = await call();
    if (!result.ok) {
      setBusy(false);
      setProblem(describeBindingFailure(result.code));
      return;
    }
    go(result.data.url);
  }

  async function disconnect(integrationId: string) {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const result = await api.disconnect(integrationId);
    setBusy(false);
    setConfirming(null);
    if (!result.ok) setProblem(describeBindingFailure(result.code));
    router.refresh();
  }

  const connectBlocked =
    data.connect === "app_not_configured" ||
    data.connect === "user_authorization_not_configured";

  return (
    <>
      {data.notice !== null ? (
        <p
          role={data.notice.tone === "error" ? "alert" : "status"}
          className={`alert alert-${data.notice.tone === "error" ? "error" : data.notice.tone === "success" ? "success" : "warning"}`}
        >
          {data.notice.text}
        </p>
      ) : null}
      {problem !== null ? (
        <p role="alert" className="alert alert-error">
          {problem}
        </p>
      ) : null}

      <section className="settings-section" aria-labelledby={`${ids}-list`}>
        <h2 id={`${ids}-list`}>GitHub installations</h2>
        {data.connections.length === 0 ? (
          <p className="muted">
            No GitHub installation is connected to this workspace yet.
            {canManage
              ? " Connect GitHub to see your repositories."
              : " An Owner or Admin of the workspace can connect GitHub."}
          </p>
        ) : (
          <ul className="member-list" aria-label="Connections">
            {data.connections.map((connection) => (
              <li
                key={connection.id}
                className="member-row"
                data-connection={connection.id}
              >
                <div className="member-main">
                  <span className="member-name">{connection.accountLogin}</span>
                  <span className="muted small">
                    {connection.accountType === "Organization"
                      ? "Organization"
                      : connection.accountType === "User"
                        ? "Personal account"
                        : "Account"}
                    {connection.status === "active"
                      ? `, ${String(connection.repositoryCount)} ${connection.repositoryCount === 1 ? "repository" : "repositories"}`
                      : ""}
                  </span>
                </div>
                <div className="member-role">
                  <span className="badge">
                    {STATUS_COPY[connection.status]}
                  </span>
                </div>
                <div className="member-actions">
                  {canManage && connection.status !== "disconnected" ? (
                    confirming === connection.id ? (
                      <>
                        <span className="muted small">
                          Projects and runs stay. Nothing changes on GitHub.
                        </span>
                        <Button
                          variant="destructive"
                          disabled={busy}
                          aria-label={`Confirm disconnecting ${connection.accountLogin}`}
                          onClick={() => void disconnect(connection.id)}
                        >
                          Disconnect
                        </Button>
                        <Button
                          variant="secondary"
                          disabled={busy}
                          onClick={() => setConfirming(null)}
                        >
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="secondary"
                        disabled={busy}
                        aria-label={`Disconnect ${connection.accountLogin}`}
                        onClick={() => setConfirming(connection.id)}
                      >
                        Disconnect
                      </Button>
                    )
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canManage ? (
        <section className="settings-section" aria-labelledby={`${ids}-add`}>
          <h2 id={`${ids}-add`}>Connect GitHub</h2>
          <p className="muted">
            You connect an installation of the GitHub App if you own the account
            it is on (a personal account, or an organization you are an owner
            of). GitHub asks you to authorize the app, which proves that.
          </p>
          {connectBlocked ? (
            <p role="note" className="alert alert-warning">
              {
                AVAILABILITY_COPY[
                  data.connect as keyof typeof AVAILABILITY_COPY
                ]
              }
            </p>
          ) : data.connect === "needs_approval" ? (
            <p role="note" className="alert alert-warning">
              {AVAILABILITY_COPY.needs_approval}
            </p>
          ) : null}
          <div className="form-actions">
            <Button
              disabled={busy || connectBlocked}
              onClick={() => void begin(() => api.connect())}
            >
              Connect GitHub
            </Button>
            {data.picker ? (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void begin(() => api.startPicker())}
              >
                Link an existing installation
              </Button>
            ) : null}
          </div>

          {data.choices !== null ? (
            data.choices.entries.length === 0 ? (
              <p className="muted">
                GitHub shows no installation that you can use and that is not
                connected to a workspace yet.
              </p>
            ) : (
              <ul
                className="member-list"
                aria-label="Installations you can link"
              >
                {data.choices.entries.map((entry) => (
                  <li key={entry.installationId} className="member-row">
                    <div className="member-main">
                      <span className="member-name">{entry.accountLogin}</span>
                      <span className="muted small">
                        {entry.accountType === "Organization"
                          ? "Organization"
                          : "Personal account"}
                      </span>
                    </div>
                    <div className="member-actions">
                      <Button
                        variant="secondary"
                        disabled={busy}
                        aria-label={`Link ${entry.accountLogin}`}
                        onClick={() =>
                          void begin(() =>
                            api.choose(
                              (data.choices as { picker: string }).picker,
                              entry.installationId,
                            ),
                          )
                        }
                      >
                        Link
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </section>
      ) : null}

      {canManage && data.requests !== null && data.requests.length > 0 ? (
        <section
          className="settings-section"
          aria-labelledby={`${ids}-requests`}
        >
          <h2 id={`${ids}-requests`}>Requests</h2>
          <p className="muted">
            The admin of this instance decides these, because GitHub did not let
            the app check your role in the organization.
          </p>
          <ul
            className="member-list"
            aria-label="Requests for the instance admin"
          >
            {data.requests.map((request) => (
              <li key={request.id} className="member-row">
                <div className="member-main">
                  <span className="member-name">{request.accountLogin}</span>
                  <span className="muted small">
                    Asked{" "}
                    <time dateTime={request.createdAt}>
                      {formatUtc(request.createdAt)}
                    </time>
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
        </section>
      ) : null}
    </>
  );
}
