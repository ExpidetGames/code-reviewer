-- The database of an installation of the previous release (before accounts), as a text dump: the schema of
-- the 13 migrations up to 20261011100000_add_jobs_repository_recent_index with their records in
-- kysely_migration, three people who signed in with GitHub (smoke-alice, smoke-bob, smoke-eve; the first is
-- bound to her GitHub id in allowed_login_pins), one GitHub installation with two repositories (one with an
-- active project and two finished reviews, with their comments and webhook deliveries) and saved review
-- defaults. Dummy data only. docker/smoke/upgrade.sh loads it into the data volume of the image under test.
--
-- It is a frozen fixture, not a generated file: the previous release does not change. It was made with
-- app/src/test-support/legacy-installation-cli.ts (the seed is in docker/smoke/fixtures/previous-release.json)
-- and `sqlite3 app.db .dump`. app/src/ci/upgrade-fixture.test.ts keeps it in step with the migrations.
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE IF NOT EXISTS "kysely_migration" ("name" varchar(255) not null primary key, "timestamp" varchar(255) not null);
INSERT INTO kysely_migration VALUES('0001_create_app_meta','2026-10-12T06:03:17.274Z');
INSERT INTO kysely_migration VALUES('20261010123800_create_auth_tables','2026-10-12T06:03:17.276Z');
INSERT INTO kysely_migration VALUES('20261010125500_add_user_org_checked_at','2026-10-12T06:03:17.276Z');
INSERT INTO kysely_migration VALUES('20261010131500_add_user_org_checked_for','2026-10-12T06:03:17.276Z');
INSERT INTO kysely_migration VALUES('20261010133000_create_allowed_login_pins','2026-10-12T06:03:17.277Z');
INSERT INTO kysely_migration VALUES('20261010134000_create_integrations','2026-10-12T06:03:17.277Z');
INSERT INTO kysely_migration VALUES('20261010143000_create_repositories','2026-10-12T06:03:17.277Z');
INSERT INTO kysely_migration VALUES('20261010170000_create_webhook_deliveries','2026-10-12T06:03:17.277Z');
INSERT INTO kysely_migration VALUES('20261010190000_create_projects','2026-10-12T06:03:17.277Z');
INSERT INTO kysely_migration VALUES('20261010191500_create_jobs','2026-10-12T06:03:17.278Z');
INSERT INTO kysely_migration VALUES('20261010201500_create_app_settings','2026-10-12T06:03:17.278Z');
INSERT INTO kysely_migration VALUES('20261011090000_create_job_comments','2026-10-12T06:03:17.278Z');
INSERT INTO kysely_migration VALUES('20261011100000_add_jobs_repository_recent_index','2026-10-12T06:03:17.279Z');
CREATE TABLE IF NOT EXISTS "kysely_migration_lock" ("id" varchar(255) not null primary key, "is_locked" integer default 0 not null);
INSERT INTO kysely_migration_lock VALUES('migration_lock',0);
CREATE TABLE IF NOT EXISTS "app_meta" ("key" text primary key, "value" text not null, "updated_at" text not null);
CREATE TABLE IF NOT EXISTS "users" ("id" text primary key, "name" text not null, "email" text not null unique, "email_verified" integer default 0 not null, "image" text, "github_login" text not null, "created_at" text not null, "updated_at" text not null, "org_checked_at" text, "org_checked_for" text);
INSERT INTO users VALUES('legacy-user-9001','smoke-alice','9001+smoke-alice@users.noreply.github.com',1,'https://avatars.example.test/u/9001','smoke-alice','2026-09-01T10:00:00.000Z','2026-09-01T10:00:00.000Z',NULL,NULL);
INSERT INTO users VALUES('legacy-user-9002','smoke-bob','9002+smoke-bob@users.noreply.github.com',1,'https://avatars.example.test/u/9002','smoke-bob','2026-09-02T10:00:00.000Z','2026-09-02T10:00:00.000Z',NULL,NULL);
INSERT INTO users VALUES('legacy-user-9003','smoke-eve','9003+smoke-eve@users.noreply.github.com',1,'https://avatars.example.test/u/9003','smoke-eve','2026-09-03T10:00:00.000Z','2026-09-03T10:00:00.000Z',NULL,NULL);
CREATE TABLE IF NOT EXISTS "sessions" ("id" text primary key, "expires_at" text not null, "token" text not null unique, "created_at" text not null, "updated_at" text not null, "ip_address" text, "user_agent" text, "user_id" text not null references "users" ("id") on delete cascade);
INSERT INTO sessions VALUES('legacy-session-9001','2027-11-05T09:00:00.000Z','legacy-session-token-9001','2026-09-01T10:00:00.000Z','2026-09-01T10:00:00.000Z',NULL,NULL,'legacy-user-9001');
INSERT INTO sessions VALUES('legacy-session-9002','2027-11-05T09:00:00.000Z','legacy-session-token-9002','2026-09-02T10:00:00.000Z','2026-09-02T10:00:00.000Z',NULL,NULL,'legacy-user-9002');
INSERT INTO sessions VALUES('legacy-session-9003','2027-11-05T09:00:00.000Z','legacy-session-token-9003','2026-09-03T10:00:00.000Z','2026-09-03T10:00:00.000Z',NULL,NULL,'legacy-user-9003');
CREATE TABLE IF NOT EXISTS "accounts" ("id" text primary key, "account_id" text not null, "provider_id" text not null, "user_id" text not null references "users" ("id") on delete cascade, "access_token" text, "refresh_token" text, "id_token" text, "access_token_expires_at" text, "refresh_token_expires_at" text, "scope" text, "password" text, "created_at" text not null, "updated_at" text not null);
INSERT INTO accounts VALUES('legacy-account-9001','9001','github','legacy-user-9001',NULL,NULL,NULL,NULL,NULL,'read:user,user:email,read:org',NULL,'2026-09-01T10:00:00.000Z','2026-09-01T10:00:00.000Z');
INSERT INTO accounts VALUES('legacy-account-9002','9002','github','legacy-user-9002',NULL,NULL,NULL,NULL,NULL,'read:user,user:email,read:org',NULL,'2026-09-02T10:00:00.000Z','2026-09-02T10:00:00.000Z');
INSERT INTO accounts VALUES('legacy-account-9003','9003','github','legacy-user-9003',NULL,NULL,NULL,NULL,NULL,'read:user,user:email,read:org',NULL,'2026-09-03T10:00:00.000Z','2026-09-03T10:00:00.000Z');
CREATE TABLE IF NOT EXISTS "verifications" ("id" text primary key, "identifier" text not null, "value" text not null, "expires_at" text not null, "created_at" text not null, "updated_at" text not null);
CREATE TABLE IF NOT EXISTS "allowed_login_pins" ("login" text primary key, "github_id" text not null, "pinned_at" text not null);
INSERT INTO allowed_login_pins VALUES('smoke-alice','9001','2026-10-01T09:00:00.000Z');
CREATE TABLE IF NOT EXISTS "integrations" ("id" text primary key, "type" text not null, "display_name" text not null, "external_id" text not null, "config" text not null, "credentials" text, "webhook_secret" text, "status" text not null, "created_at" text not null, "updated_at" text not null);
INSERT INTO integrations VALUES('legacy-integration-9100','github_app','smoke-org','9100','{"accountLogin":"smoke-org","accountId":9200}',NULL,NULL,'active','2026-10-01T09:00:00.000Z','2026-10-01T09:00:00.000Z');
CREATE TABLE IF NOT EXISTS "repositories" ("id" text primary key, "integration_id" text not null references "integrations" ("id"), "external_id" text not null, "full_name" text not null, "url" text not null, "active" integer not null, "created_at" text not null, "updated_at" text not null);
INSERT INTO repositories VALUES('legacy-repository-9300','legacy-integration-9100','9300','smoke-org/widgets','https://github.test/smoke-org/widgets',1,'2026-10-01T09:00:00.000Z','2026-10-01T09:00:00.000Z');
INSERT INTO repositories VALUES('legacy-repository-9301','legacy-integration-9100','9301','smoke-org/gadgets','https://github.test/smoke-org/gadgets',1,'2026-10-01T09:00:00.000Z','2026-10-01T09:00:00.000Z');
CREATE TABLE IF NOT EXISTS "webhook_deliveries" ("delivery_id" text primary key, "event" text not null, "outcome" text not null, "claim_token" text not null, "received_at" text not null);
INSERT INTO webhook_deliveries VALUES('legacy-delivery-9300-1','pull_request','processed','legacy-claim','2026-10-01T09:00:00.000Z');
INSERT INTO webhook_deliveries VALUES('legacy-delivery-9300-2','pull_request','processed','legacy-claim','2026-10-01T09:00:00.000Z');
CREATE TABLE IF NOT EXISTS "projects" ("id" text primary key, "repository_id" text not null unique references "repositories" ("id"), "active" integer not null, "settings" text not null, "created_at" text not null, "updated_at" text not null);
INSERT INTO projects VALUES('legacy-project-9300','legacy-repository-9300',1,'{"maxFindings":9}','2026-10-01T09:00:00.000Z','2026-10-01T09:00:00.000Z');
CREATE TABLE IF NOT EXISTS "jobs" ("id" text primary key, "repository_id" text not null references "repositories" ("id"), "pr_number" integer not null, "pr_url" text not null, "head_sha" text not null, "command" text not null, "args" text not null, "trigger_kind" text not null, "actor_login" text not null, "delivery_id" text, "status" text not null, "run_after" text not null, "attempts" integer not null, "runner_id" text, "lease_token" text, "claimed_at" text, "heartbeat_at" text, "lease_expires_at" text, "result" text, "error_code" text, "superseded_by" text references "jobs" ("id"), "created_at" text not null, "updated_at" text not null, "finished_at" text);
INSERT INTO jobs VALUES('legacy-job-9300-1','legacy-repository-9300',1,'https://github.test/smoke-org/widgets/pull/1','1111111111111111111111111111111111111111','review','','webhook','smoke-alice','legacy-delivery-9300-1','succeeded','2026-10-01T09:00:00.000Z',1,NULL,NULL,NULL,NULL,NULL,'{"ok":true,"durationMs":4200,"commentUrl":"https://github.test/smoke-org/widgets/pull/1#issuecomment-1"}',NULL,NULL,'2026-10-01T09:00:00.000Z','2026-10-01T09:00:00.000Z','2026-10-01T09:00:00.000Z');
INSERT INTO jobs VALUES('legacy-job-9300-2','legacy-repository-9300',2,'https://github.test/smoke-org/widgets/pull/2','2222222222222222222222222222222222222222','review','','webhook','smoke-alice','legacy-delivery-9300-2','succeeded','2026-10-01T09:00:00.000Z',1,NULL,NULL,NULL,NULL,NULL,'{"ok":true,"durationMs":4200,"commentUrl":"https://github.test/smoke-org/widgets/pull/2#issuecomment-2"}',NULL,NULL,'2026-10-01T09:00:00.000Z','2026-10-01T09:00:00.000Z','2026-10-01T09:00:00.000Z');
CREATE TABLE IF NOT EXISTS "app_settings" ("key" text primary key, "value" text not null, "updated_at" text not null, "updated_by" text);
INSERT INTO app_settings VALUES('review_defaults','{"maxFindings":7,"largePrChunking":true}','2026-10-01T09:00:00.000Z','smoke-alice');
CREATE TABLE IF NOT EXISTS "job_comments" ("repository_id" text not null references "repositories" ("id"), "comment_id" text not null, "job_id" text not null references "jobs" ("id"), constraint "job_comments_pk" primary key ("repository_id", "comment_id"));
INSERT INTO job_comments VALUES('legacy-repository-9300','1001','legacy-job-9300-1');
INSERT INTO job_comments VALUES('legacy-repository-9300','1002','legacy-job-9300-2');
CREATE INDEX "sessions_user_id_index" on "sessions" ("user_id");
CREATE INDEX "accounts_user_id_index" on "accounts" ("user_id");
CREATE INDEX "verifications_identifier_index" on "verifications" ("identifier");
CREATE UNIQUE INDEX "integrations_type_external_id_unique" on "integrations" ("type", "external_id");
CREATE UNIQUE INDEX "repositories_integration_external_id_unique" on "repositories" ("integration_id", "external_id");
CREATE INDEX "webhook_deliveries_received_at" on "webhook_deliveries" ("received_at");
CREATE UNIQUE INDEX "jobs_delivery_id_unique" on "jobs" ("delivery_id");
CREATE UNIQUE INDEX "jobs_automatic_per_head_unique" on "jobs" ("repository_id", "pr_number", "head_sha", "command") where trigger_kind = 'webhook' and status in ('queued', 'running', 'succeeded', 'failed');
CREATE UNIQUE INDEX "jobs_one_running_per_pull_request_unique" on "jobs" ("repository_id", "pr_number") where "status" = 'running';
CREATE INDEX "jobs_status_run_after" on "jobs" ("status", "run_after");
CREATE INDEX "jobs_pull_request" on "jobs" ("repository_id", "pr_number", "command");
CREATE INDEX "job_comments_job" on "job_comments" ("job_id");
CREATE INDEX "jobs_repository_recent" on "jobs" ("repository_id", "created_at", "id");
COMMIT;
