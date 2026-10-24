// SPDX-License-Identifier: LicenseRef-Proprietary

// Who may call a route the hosting platform's cron calls (`vercel.json` "crons"). The platform sends
// `Authorization: Bearer <CRON_SECRET>`; the secret is the whole credential, so a missing or weak one
// refuses every caller instead of opening the route. These routes exist only in serverless mode: on a
// server (Docker, Coolify) they answer 404 like any path that is not there.
import "server-only";
import { isServerless } from "../runtime/mode.ts";
import { bearerTokenOf, tokensMatch } from "../runner-api/token-auth.ts";

export const CRON_ERROR_CODES = ["CRON_UNAUTHORIZED"] as const;
export type CronErrorCode = (typeof CRON_ERROR_CODES)[number];

type Env = Readonly<Record<string, string | undefined>>;

/** The refusal to send, or null when the caller may go on. */
export function refuseUnlessCron(request: Request, env: Env): Response | null {
  if (!isServerless(env)) return new Response(null, { status: 404 });
  const provided = bearerTokenOf(request.headers.get("authorization"));
  // `tokensMatch` never matches a missing or short configured secret (under 32 characters).
  if (provided !== null && tokensMatch(env.CRON_SECRET, provided)) return null;
  return Response.json(
    { code: "CRON_UNAUTHORIZED" satisfies CronErrorCode },
    { status: 401, headers: { "cache-control": "no-store" } },
  );
}
