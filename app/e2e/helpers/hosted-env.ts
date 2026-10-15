// SPDX-License-Identifier: Apache-2.0

// Addresses, files and dummy credentials of the hosted end-to-end lane (#332, playwright.hosted.config.ts and the
// journeys of e2e/hosted/): the app in its serverless mode over Postgres, the Dispatcher as a process, and the loopback
// fakes. Shared by the configuration (which starts the app and the fake GitHub) and the journeys (which start the
// Dispatcher and the fake LLM). Nothing here is a secret: the values only have to match between the processes under
// test, and they differ from each other (the app refuses a signing secret that is another credential).
import { e2eEnv } from "./e2e-env";

const appPort = Number(process.env.E2E_HOSTED_PORT) || 3617;
// The Dispatcher listens on the next port; the app is told its address at start (RUNNER_WEBHOOK_URL), and the
// journeys start and stop the process, so "the Dispatcher is down" is simply that nothing listens there.
const dispatcherPort = appPort + 1;

for (const port of [appPort, dispatcherPort])
  if (port === 3000 || port === 3100)
    throw new Error(
      `The hosted lane must not use port ${String(port)}: other work runs there. Set E2E_HOSTED_PORT to a private one.`,
    );

/**
 * The Postgres server the lane makes its database on: `E2E_DATABASE_URL`, a URL whose user may create and drop
 * databases (CI: the service container of the job; on a machine: any server you own). A missing value is a failure
 * that says so, never a skip.
 */
function adminDatabaseUrl(): URL {
  const value = process.env.E2E_DATABASE_URL?.trim();
  if (!value)
    throw new Error(
      "E2E_DATABASE_URL is not set: the hosted lane needs a Postgres server it may create a database on (for example postgres://postgres:postgres@127.0.0.1:5432/postgres).",
    );
  const url = new URL(value);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    throw new Error(
      "E2E_DATABASE_URL must point at this machine (127.0.0.1): a test never uses a database somewhere else.",
    );
  return url;
}

/** The server URL with the database of this run's app (`cr_e2e_hosted_<port>`, dropped and made again at start). */
export function hostedDatabaseUrls(): {
  admin: string;
  app: string;
  name: string;
} {
  const admin = adminDatabaseUrl();
  const name = `cr_e2e_hosted_${String(appPort)}`;
  const app = new URL(admin);
  app.pathname = `/${name}`;
  return { admin: admin.toString(), app: app.toString(), name };
}

const directory = "test-results/e2e-hosted";

export const hostedEnv = {
  appPort,
  appUrl: `http://127.0.0.1:${String(appPort)}`,
  dispatcherPort,
  dispatcherUrl: `http://127.0.0.1:${String(dispatcherPort)}`,
  /** Where the lane keeps its files, relative to the app folder; fresh for every run. */
  directory,
  logFiles: {
    app: `${directory}/app.log`,
    dispatcher: `${directory}/dispatcher.log`,
  },
  /** The records of the `docker` stand-in (`fakes/sandbox/bin/docker-worker.sh`): one set of files per container. */
  dockerDirectory: `${directory}/docker`,
  /** What a journey writes to steer the Dispatcher process (`dispatcher/src/test-support/hosted-e2e-main.ts`). */
  controlDirectory: `${directory}/control`,
  /** The key the app signs the wake-up call with (the Dispatcher's `DISPATCHER_SIGNING_*`), 32 characters at least. */
  webhookKeyId: "e2e1",
  webhookSecret: "e2e-dispatch-webhook-secret-0123456789-abcdef",
  /** `Authorization: Bearer` of the cron routes. */
  cronSecret: "e2e-cron-secret-0123456789-0123456789-abcdef",
  /** The id of the Dispatcher's pool, which the app counts running jobs by. */
  poolId: "e2e-pool",
  /** The image id the Launcher requires and the `docker` stand-in reports. A dummy: no image exists. */
  imageId: `sha256:${"e2e0".repeat(16)}`,
  // The same dummies as every other app of the e2e runs: the master key, the dispatcher credential and the
  // runner token are the shared ones; the signing secret and the cron secret above are the lane's own.
  appSecret: e2eEnv.appSecret,
  dispatcherToken: e2eEnv.runnerToken,
};

/** Every credential of the lane, to search outputs for. */
export function hostedSecrets(): string[] {
  return [
    hostedEnv.webhookSecret,
    hostedEnv.cronSecret,
    hostedEnv.appSecret,
    hostedEnv.dispatcherToken,
  ];
}
