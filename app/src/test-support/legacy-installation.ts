// SPDX-License-Identifier: Apache-2.0

// A database as the release before accounts left it, with the data of an installation that has been running for
// a while: people who signed in with GitHub (their access tokens stored the way Better Auth stored them, encrypted
// with the master key), the pins of the allowed logins, connections to GitHub installations with their
// repositories, active projects, finished jobs with their comments, the review defaults and the webhook
// deliveries. It migrates a new file with the migrations that existed BEFORE accounts (everything older than the
// first workspace migration) and writes the rows with plain SQL, the way that version's code did, so the update
// has to deal with exactly what a real installation holds.
//
// Used by the integration tests of the import, by the journey of the update (e2e/upgrade/) and by the smoke test
// of the image (docker/smoke/upgrade.sh, through legacy-installation-cli.ts). No `vitest` import: the programs
// run it with plain Node.
import { symmetricEncrypt } from "better-auth/crypto";
import type { Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { openDatabase } from "../db/connection.ts";
import { migrateToLatest } from "../db/migrate.ts";
import { migrationProvider } from "../db/migrations/index.ts";

/** The first migration of the version with workspaces; every migration before it is the previous release's. */
export const FIRST_MIGRATION_AFTER_THE_PREVIOUS_RELEASE =
  "20261011160000_create_workspaces";

/** The migrations of the release before accounts. */
export const previousReleaseMigrations: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < FIRST_MIGRATION_AFTER_THE_PREVIOUS_RELEASE,
      ),
    );
  },
};

export type LegacyUserSeed = {
  /** The login the person signed in with. */
  login: string;
  /** The numeric GitHub id. */
  githubId: number;
  /** When the person first signed in (ISO 8601). Users are created in the order of this time. */
  createdAt?: string;
  /**
   * The access token GitHub issued at the last sign in (plain; it is stored encrypted). Null: the row has none
   * (a token that was never stored).
   */
  token?: string | null;
  /** Stores a token that cannot be decrypted with the master key (another secret was used). */
  tokenFromAnotherSecret?: boolean;
  /** The address of the profile. Default: the placeholder of GitHub. */
  email?: string;
  /** The scope of the token. Default: what the sign in asked for. */
  scope?: string;
};

export type LegacyInstallationSeed = {
  /** The GitHub installation id. */
  id: number;
  accountLogin: string;
  accountId: number;
  repositories: Array<{ id: number; fullName: string; project?: boolean }>;
};

export type LegacySeed = {
  /** The master key the previous release ran with (`BETTER_AUTH_SECRET`). */
  secret: string;
  users: LegacyUserSeed[];
  /** Logins bound to a GitHub id in `allowed_login_pins`. */
  pins?: Array<{ login: string; githubId: number }>;
  installations?: LegacyInstallationSeed[];
  /** Finished jobs per repository (default 2 for the first repository of each installation). */
  jobsPerProject?: number;
  /** The review defaults the team saved (default: a few). Null: none saved. */
  reviewDefaults?: Record<string, unknown> | null;
};

const T = "2026-10-01T09:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;

/** Creates `path` as the database of an installation of the previous release. */
export async function createLegacyInstallation(
  path: string,
  seed: LegacySeed,
): Promise<void> {
  const db = openDatabase({ path, busyTimeoutMs: 5000 });
  try {
    await migrateToLatest(db, previousReleaseMigrations);
    await seedLegacyRows(db, seed);
  } finally {
    await db.destroy();
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the old schema is not the current Database type.
type OldDb = Kysely<any>;

async function seedLegacyRows(db: OldDb, seed: LegacySeed): Promise<void> {
  const base = Date.parse(T);
  for (const [index, user] of seed.users.entries()) {
    const id = `legacy-user-${String(user.githubId)}`;
    const createdAt =
      user.createdAt ?? new Date(base + index * DAY).toISOString();
    await db
      .insertInto("users")
      .values({
        id,
        name: user.login,
        email:
          user.email ??
          `${String(user.githubId)}+${user.login}@users.noreply.github.com`,
        email_verified: 1,
        image: `https://avatars.example.test/u/${String(user.githubId)}`,
        github_login: user.login,
        org_checked_at: null,
        org_checked_for: null,
        created_at: createdAt,
        updated_at: createdAt,
      })
      .execute();
    const stored =
      user.token == null
        ? null
        : await symmetricEncrypt({
            key: user.tokenFromAnotherSecret
              ? `${seed.secret}-not-this-one`
              : seed.secret,
            data: user.token,
          });
    await db
      .insertInto("accounts")
      .values({
        id: `legacy-account-${String(user.githubId)}`,
        account_id: String(user.githubId),
        provider_id: "github",
        user_id: id,
        access_token: stored,
        scope: user.scope ?? "read:user,user:email,read:org",
        created_at: createdAt,
        updated_at: createdAt,
      })
      .execute();
    await db
      .insertInto("sessions")
      .values({
        id: `legacy-session-${String(user.githubId)}`,
        expires_at: new Date(base + 400 * DAY).toISOString(),
        token: `legacy-session-token-${String(user.githubId)}`,
        created_at: createdAt,
        updated_at: createdAt,
        user_id: id,
      })
      .execute();
  }

  for (const pin of seed.pins ?? [])
    await db
      .insertInto("allowed_login_pins")
      .values({
        login: pin.login.toLowerCase(),
        github_id: String(pin.githubId),
        pinned_at: T,
      })
      .execute();

  const jobsPerProject = seed.jobsPerProject ?? 2;
  for (const installation of seed.installations ?? []) {
    const integrationId = `legacy-integration-${String(installation.id)}`;
    await db
      .insertInto("integrations")
      .values({
        id: integrationId,
        type: "github_app",
        display_name: installation.accountLogin,
        external_id: String(installation.id),
        config: JSON.stringify({
          accountLogin: installation.accountLogin,
          accountId: installation.accountId,
        }),
        status: "active",
        created_at: T,
        updated_at: T,
      })
      .execute();
    for (const repository of installation.repositories) {
      const repositoryId = `legacy-repository-${String(repository.id)}`;
      await db
        .insertInto("repositories")
        .values({
          id: repositoryId,
          integration_id: integrationId,
          external_id: String(repository.id),
          full_name: repository.fullName,
          url: `https://github.test/${repository.fullName}`,
          active: 1,
          created_at: T,
          updated_at: T,
        })
        .execute();
      if (repository.project !== true) continue;
      await db
        .insertInto("projects")
        .values({
          id: `legacy-project-${String(repository.id)}`,
          repository_id: repositoryId,
          active: 1,
          settings: JSON.stringify({ maxFindings: 9 }),
          created_at: T,
          updated_at: T,
        })
        .execute();
      for (let n = 1; n <= jobsPerProject; n += 1) {
        const jobId = `legacy-job-${String(repository.id)}-${String(n)}`;
        await db
          .insertInto("jobs")
          .values({
            id: jobId,
            repository_id: repositoryId,
            pr_number: n,
            pr_url: `https://github.test/${repository.fullName}/pull/${String(n)}`,
            head_sha: String(n).repeat(40).slice(0, 40),
            command: "review",
            args: "",
            trigger_kind: "webhook",
            actor_login: seed.users[0]?.login ?? "someone",
            delivery_id: `legacy-delivery-${String(repository.id)}-${String(n)}`,
            status: "succeeded",
            run_after: T,
            attempts: 1,
            result: JSON.stringify({
              ok: true,
              durationMs: 4200,
              commentUrl: `https://github.test/${repository.fullName}/pull/${String(n)}#issuecomment-${String(n)}`,
            }),
            created_at: T,
            updated_at: T,
            finished_at: T,
          })
          .execute();
        await db
          .insertInto("job_comments")
          .values({
            repository_id: repositoryId,
            comment_id: String(1000 + n),
            job_id: jobId,
          })
          .execute();
        await db
          .insertInto("webhook_deliveries")
          .values({
            delivery_id: `legacy-delivery-${String(repository.id)}-${String(n)}`,
            event: "pull_request",
            outcome: "processed",
            claim_token: "legacy-claim",
            received_at: T,
          })
          .execute();
      }
    }
  }

  const defaults =
    seed.reviewDefaults === undefined
      ? { maxFindings: 7, largePrChunking: true }
      : seed.reviewDefaults;
  if (defaults !== null)
    await db
      .insertInto("app_settings")
      .values({
        key: "review_defaults",
        value: JSON.stringify(defaults),
        updated_at: T,
        updated_by: seed.users[0]?.login ?? null,
      })
      .execute();
}
