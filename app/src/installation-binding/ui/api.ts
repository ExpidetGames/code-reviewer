// SPDX-License-Identifier: LicenseRef-Proprietary

// The calls the connections page and the approvals page make to the app's own routes (src/installation-binding/
// http.ts, approvals-http.ts). Browser side; no secrets: an answer holds an address on GitHub (the installation
// page or the authorization page) and nothing else. The workspace is the one of the page that makes the call.
import { workspaceApiPath } from "../../workspaces/paths.ts";
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";
import type { WorkspaceSyncAnswer } from "../http.ts";

export type AddressAnswer = { ok: true; url: string };

export type BindingApi = {
  connect(): Promise<RequestResult<AddressAnswer>>;
  startPicker(): Promise<RequestResult<AddressAnswer>>;
  choose(
    picker: string,
    installationId: string,
  ): Promise<RequestResult<AddressAnswer>>;
  disconnect(integrationId: string): Promise<RequestResult<{ ok: true }>>;
  sync(): Promise<RequestResult<WorkspaceSyncAnswer>>;
};

export function createBindingApi(
  fetchImpl: FetchLike,
  workspaceSlug: string,
): BindingApi {
  const path = (rest: string) => workspaceApiPath(workspaceSlug, rest);
  return {
    connect: () => requestJson(fetchImpl, "POST", path("/github/connect"), {}),
    startPicker: () =>
      requestJson(fetchImpl, "POST", path("/github/installations"), {}),
    choose: (picker, installationId) =>
      requestJson(fetchImpl, "POST", path("/github/installations/choose"), {
        picker,
        installationId,
      }),
    disconnect: (integrationId) =>
      requestJson(
        fetchImpl,
        "DELETE",
        path(`/integrations/${encodeURIComponent(integrationId)}`),
      ),
    sync: () => requestJson(fetchImpl, "POST", path("/integrations/sync")),
  };
}

export function browserBindingApi(workspaceSlug: string): BindingApi {
  return createBindingApi((url, init) => fetch(url, init), workspaceSlug);
}

export type ApprovalsApi = {
  decide(
    requestId: string,
    decision: "approve" | "deny",
  ): Promise<RequestResult<{ ok: true }>>;
};

export function createApprovalsApi(fetchImpl: FetchLike): ApprovalsApi {
  return {
    decide: (requestId, decision) =>
      requestJson(
        fetchImpl,
        "POST",
        `/api/admin/approvals/${encodeURIComponent(requestId)}`,
        { decision },
      ),
  };
}

export const browserApprovalsApi: ApprovalsApi = createApprovalsApi(
  (url, init) => fetch(url, init),
);
