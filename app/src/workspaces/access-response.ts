// SPDX-License-Identifier: Apache-2.0

// What a data route answers when a request may not act in a workspace (access.ts). One answer per reason,
// `{ "error": <code> }` with `Cache-Control: no-store`:
//
// - 401 `UNAUTHENTICATED`: no session.
// - 403 `email_not_verified`, 403 `no_workspace_access`: the session is not allowed to use the app yet (the
//   proxy answers these before the route; this is for a route reached without it).
// - 404 `not_found`: the workspace is not there for this person. The same body and status for a workspace
//   that does not exist, one they do not belong to and a slug that is no slug, so nothing tells them apart.
// - 403 `forbidden`: a member whose role does not allow the action. They know the workspace is there.
import type { WorkspaceAccessResult } from "./access.ts";

const NO_STORE = { "cache-control": "no-store" };

export function accessRefusal(
  result: Exclude<WorkspaceAccessResult, { kind: "ok" }>,
): Response {
  switch (result.kind) {
    case "anonymous":
      return Response.json(
        { error: "UNAUTHENTICATED" },
        { status: 401, headers: NO_STORE },
      );
    case "unverified":
      return Response.json(
        { error: "email_not_verified" },
        { status: 403, headers: NO_STORE },
      );
    case "no_workspace":
      return Response.json(
        { error: "no_workspace_access" },
        { status: 403, headers: NO_STORE },
      );
    case "not_found":
      return Response.json(
        { error: "not_found" },
        { status: 404, headers: NO_STORE },
      );
    case "forbidden":
      return Response.json(
        { error: "forbidden" },
        { status: 403, headers: NO_STORE },
      );
  }
}
