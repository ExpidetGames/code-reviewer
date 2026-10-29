// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The Connections page of a workspace (#176): the container that owns what a flow just ended with,
// the one failed call of the page and the busy flag, and lays out the three cards — Installations,
// Connect and Requests. The buttons only show what the role allows; the routes and the services
// decide for themselves. Account names come from GitHub: text, never markup.
import { useProductIdentity } from "../../product-identity/context.tsx";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { goTo } from "../../github-config/ui/api.ts";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import type { RequestResult } from "../../ui/json-request.ts";
import { browserBindingApi, type BindingApi } from "./api.ts";
import { ConnectCard } from "./connect-card.tsx";
import type { ConnectionsPageData } from "./connections-page.tsx";
import { InstallationsCard } from "./installations-card.tsx";
import { describeBindingFailure, type ResultTone } from "./messages.ts";
import { RequestsCard } from "./requests-card.tsx";

/** The tone of a result to the quiet Alert variant. */
function noticeVariant(tone: ResultTone): "success" | "info" | "destructive" {
  if (tone === "success") return "success";
  if (tone === "error") return "destructive";
  return "info";
}

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
  const product = useProductIdentity();
  const router = useRouter();
  const defaultApi = useMemo(
    () => browserBindingApi(workspaceSlug),
    [workspaceSlug],
  );
  const api = apiProp ?? defaultApi;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

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
      setProblem(describeBindingFailure(product, result.code));
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
    if (!result.ok) setProblem(describeBindingFailure(product, result.code));
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      {data.notice !== null ? (
        <Alert variant={noticeVariant(data.notice.tone)} role="status">
          <AlertDescription>{data.notice.text}</AlertDescription>
        </Alert>
      ) : null}
      {problem !== null ? (
        <Alert variant="destructive" role="status">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : null}

      <InstallationsCard
        connections={data.connections}
        canManage={canManage}
        busy={busy}
        onDisconnect={(integrationId) => void disconnect(integrationId)}
      />

      {canManage ? (
        <ConnectCard
          connect={data.connect}
          picker={data.picker}
          choices={data.choices}
          busy={busy}
          onConnect={() => void begin(() => api.connect())}
          onStartPicker={() => void begin(() => api.startPicker())}
          onChoose={(picker, installationId) =>
            void begin(() => api.choose(picker, installationId))
          }
        />
      ) : null}

      {canManage && data.requests !== null ? (
        <RequestsCard requests={data.requests} />
      ) : null}
    </div>
  );
}
