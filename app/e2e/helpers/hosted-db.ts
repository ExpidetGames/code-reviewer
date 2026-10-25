// SPDX-License-Identifier: LicenseRef-Proprietary

// What a journey of the hosted lane (#332) reads from and does to the database of the app under test, directly:
//
//  - It reads the state of a job and of its dispatch, where the pages and the API say less than the journey asks
//    (the attempts counted, the state of the wake-up call).
//  - It moves the clock of one job forward. The app is a separate process, so its clock cannot be injected, and the
//    waits the journeys are about are minutes long (the lease of two minutes, the acknowledgement timeout of two
//    minutes, the give-up of an hour, the thirty minutes of a Dynamic job nobody can run). Instead of sleeping, every
//    time the app has stored for the job and its dispatch is moved back by that many seconds, which is the state the
//    app would be in that long afterwards. Nothing else is written: the app's own sweep (`GET
//    /api/internal/dispatch-sweep`) then does what it does when the time has passed.
//
// The journeys never write any other row.
import { Client } from "pg";
import { hostedDatabaseUrls } from "./hosted-env";

async function withDatabase<T>(
  work: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: hostedDatabaseUrls().app });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export type JobState = {
  id: string;
  status: string;
  attempts: number;
  errorCode: string | null;
  reviewKind: string;
  headSha: string;
};

/** The jobs of a pull request, oldest first. */
export async function jobsOf(
  repositoryFullName: string,
  prNumber: number,
): Promise<JobState[]> {
  return withDatabase(async (client) => {
    const { rows } = await client.query<{
      id: string;
      status: string;
      attempts: number;
      error_code: string | null;
      review_kind: string;
      head_sha: string;
    }>(
      `SELECT j.id, j.status, j.attempts, j.error_code, j.review_kind, j.head_sha
         FROM jobs j JOIN repositories r ON r.id = j.repository_id
        WHERE r.full_name = $1 AND j.pr_number = $2
        ORDER BY j.created_at, j.id`,
      [repositoryFullName, prNumber],
    );
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      attempts: row.attempts,
      errorCode: row.error_code,
      reviewKind: row.review_kind,
      headSha: row.head_sha,
    }));
  });
}

/** The one job of a pull request; fails when there are none or several. */
export async function onlyJobOf(
  repositoryFullName: string,
  prNumber: number,
): Promise<JobState> {
  const jobs = await jobsOf(repositoryFullName, prNumber);
  const [job] = jobs;
  if (jobs.length !== 1 || job === undefined)
    throw new Error(
      `${repositoryFullName}#${String(prNumber)} has ${String(jobs.length)} jobs, one was expected.`,
    );
  return job;
}

export type DispatchState = {
  state: string;
  attempts: number;
  consecutiveFailures: number;
  lastStatus: number | null;
  lastCode: string | null;
};

/** Where the wake-up call of a job stands; null while the app has made no row for it. */
export async function dispatchOf(jobId: string): Promise<DispatchState | null> {
  return withDatabase(async (client) => {
    const { rows } = await client.query<{
      state: string;
      attempts: number;
      consecutive_failures: number;
      last_status: number | null;
      last_code: string | null;
    }>(
      `SELECT state, attempts, consecutive_failures, last_status, last_code
         FROM job_dispatches WHERE job_id = $1`,
      [jobId],
    );
    const [row] = rows;
    if (row === undefined) return null;
    return {
      state: row.state,
      attempts: row.attempts,
      consecutiveFailures: row.consecutive_failures,
      lastStatus: row.last_status,
      lastCode: row.last_code,
    };
  });
}

const JOB_TIMES = [
  "run_after",
  "claimed_at",
  "heartbeat_at",
  "lease_expires_at",
  "created_at",
  "updated_at",
] as const;
const DISPATCH_TIMES = [
  "next_dispatch_at",
  "acked_at",
  "last_attempt_at",
  "created_at",
  "updated_at",
] as const;

/** The text of a stored time moved back by `$2` seconds, in the form the app stores (ISO 8601, milliseconds, `Z`). */
function earlier(column: string): string {
  return `to_char((${column}::timestamptz - make_interval(secs => $2)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

/**
 * Lets `seconds` pass for one job: every time stored for it and for its dispatch moves back by that much. A lease
 * that had two minutes to run is then over, a job queued a minute ago has been queued an hour, and a call that was
 * to be sent again in two minutes is due. One statement, with the arithmetic in the database: the app's own writes
 * (a heartbeat, an acknowledgement) cannot fall between a read and a write of the journey, and a null stays null.
 */
export async function letTimePass(
  jobId: string,
  seconds: number,
): Promise<void> {
  const moved = await withDatabase((client) =>
    client.query<{ jobs: string }>(
      `WITH moved_job AS (
         UPDATE jobs SET ${JOB_TIMES.map((name) => `${name} = ${earlier(name)}`).join(", ")}
          WHERE id = $1 RETURNING id
       ), moved_dispatch AS (
         UPDATE job_dispatches SET ${DISPATCH_TIMES.map((name) => `${name} = ${earlier(name)}`).join(", ")}
          WHERE job_id = $1 RETURNING job_id
       )
       SELECT (SELECT count(*) FROM moved_job) AS jobs, (SELECT count(*) FROM moved_dispatch) AS dispatches`,
      [jobId, seconds],
    ),
  );
  if (Number(moved.rows[0]?.jobs ?? 0) !== 1)
    throw new Error(`There is no job ${jobId}.`);
}
