// SPDX-License-Identifier: Apache-2.0

// POST /api/invitations/accept  { "token": "..." } or { "invitationId": "..." }: accepts an invitation as
// the signed in person. The token is the link; an id comes from the list of the invitations waiting for a
// verified address (only while the instance can send mail). Open to a person who has no workspace yet:
// that is who accepts. A POST with a body and the same-site check, never a GET, so a link preview or a mail
// scanner cannot accept anything. Protected: the proxy asks for a session (src/auth/access.ts,
// NO_WORKSPACE_PATHS), and `withSignedIn` is the second guard. The rules are in
// src/workspaces/invitations.ts, the handler in src/workspaces/http.ts.
import { connection } from "next/server";
import { withSignedIn } from "@/workspaces/access-runtime";
import { getWorkspaceRouteHandlers } from "@/workspaces/shared";

export async function POST(request: Request): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  return withSignedIn((user) =>
    getWorkspaceRouteHandlers().accept(request, user),
  );
}
