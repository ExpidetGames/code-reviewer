// SPDX-License-Identifier: Apache-2.0

// GET /api/internal/dispatch-sweep, called every 2 hours by the platform's cron (`vercel.json`; a safety net, #395) in serverless
// mode (#328): lapsed leases, resends, the give-up and the hourly cleanup of a deployment in which no process
// lives long enough to do them (src/dispatch/sweep.ts). The route is a 404 anywhere else, and `CRON_SECRET` is
// the whole credential (src/cron/auth.ts). Runs can overlap (the platform may retry, a run can outlast its
// slot): a database try-lock lets one work and the others answer `skipped` at once. The answer carries counts
// only.
import "server-only";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { SWEEP_LOCK, tryWithLock } from "../db/try-lock.ts";
import type { DispatchSweep } from "../dispatch/sweep.ts";
import { refuseUnlessCron } from "./auth.ts";

export const DISPATCH_SWEEP_ERROR_CODES = ["DISPATCH_SWEEP_FAILED"] as const;

type Dependencies = {
  env: Readonly<Record<string, string | undefined>>;
  /** Both are made only for a caller that holds the secret: a refused call opens no connection. */
  db: () => Kysely<Database>;
  sweep: () => DispatchSweep;
};

export async function handleDispatchSweepCron(
  request: Request,
  { env, db, sweep }: Dependencies,
): Promise<Response> {
  const refusal = refuseUnlessCron(request, env);
  if (refusal !== null) return refusal;
  const headers = { "cache-control": "no-store" };
  try {
    const outcome = await tryWithLock(db(), SWEEP_LOCK, () => sweep().run());
    if (!outcome.acquired)
      return Response.json(
        { status: "skipped", reason: "already_running" },
        { headers },
      );
    const { failedSteps, ...counts } = outcome.value;
    if (failedSteps.length > 0)
      // The steps that did work are in the log line of the run; the answer says which ones did not.
      return Response.json(
        { status: "error", failedSteps },
        { status: 500, headers },
      );
    return Response.json({ status: "ok", ...counts }, { headers });
  } catch {
    // The cause is not repeated: it may carry a connection string. The platform shows the 500.
    console.error("[sweep] DISPATCH_SWEEP_FAILED: the sweep could not run.");
    return Response.json(
      { status: "error", code: "DISPATCH_SWEEP_FAILED" },
      { status: 500, headers },
    );
  }
}
