// The ordered list of migrations. Kysely runs them in the alphabetical order of these keys, so
// every key after the first starts with a UTC timestamp, `YYYYMMDDHHMMSS_what_it_does`; "0001" sorts
// before all of them. A migration that has run is never edited: add a new one instead. Registered
// statically (not read from the disk) so it works in a Next.js bundle.
import type { Migration, MigrationProvider } from "kysely/migration";
import { migration as createAppMeta } from "./0001_create_app_meta.ts";
import { migration as createAuthTables } from "./20261010123800_create_auth_tables.ts";
import { migration as addUserOrgCheckedAt } from "./20261010125500_add_user_org_checked_at.ts";
import { migration as addUserOrgCheckedFor } from "./20261010131500_add_user_org_checked_for.ts";
import { migration as createAllowedLoginPins } from "./20261010133000_create_allowed_login_pins.ts";
import { migration as createIntegrations } from "./20261010134000_create_integrations.ts";
import { migration as createRepositories } from "./20261010143000_create_repositories.ts";
import { migration as createWebhookDeliveries } from "./20261010170000_create_webhook_deliveries.ts";
import { migration as createProjects } from "./20261010190000_create_projects.ts";
import { migration as createJobs } from "./20261010191500_create_jobs.ts";
import { migration as createAppSettings } from "./20261010201500_create_app_settings.ts";
import { migration as createJobComments } from "./20261011090000_create_job_comments.ts";
import { migration as addJobsRepositoryRecentIndex } from "./20261011100000_add_jobs_repository_recent_index.ts";
import { migration as createWorkspaces } from "./20261011160000_create_workspaces.ts";
import { migration as addWorkspaceToCustomerData } from "./20261011160100_add_workspace_to_customer_data.ts";
import { migration as prepareUsersForAccounts } from "./20261011160200_prepare_users_for_accounts.ts";
import { migration as createInstanceSettings } from "./20261011170000_create_instance_settings.ts";
import { migration as createRateLimits } from "./20261011170100_create_rate_limits.ts";
import { migration as addInstanceAdminFlagToUsers } from "./20261011170200_add_instance_admin_flag_to_users.ts";

const migrations: Record<string, Migration> = {
  "0001_create_app_meta": createAppMeta,
  "20261010123800_create_auth_tables": createAuthTables,
  "20261010125500_add_user_org_checked_at": addUserOrgCheckedAt,
  "20261010131500_add_user_org_checked_for": addUserOrgCheckedFor,
  "20261010133000_create_allowed_login_pins": createAllowedLoginPins,
  "20261010134000_create_integrations": createIntegrations,
  "20261010143000_create_repositories": createRepositories,
  "20261010170000_create_webhook_deliveries": createWebhookDeliveries,
  "20261010190000_create_projects": createProjects,
  "20261010191500_create_jobs": createJobs,
  "20261010201500_create_app_settings": createAppSettings,
  "20261011090000_create_job_comments": createJobComments,
  "20261011100000_add_jobs_repository_recent_index":
    addJobsRepositoryRecentIndex,
  "20261011160000_create_workspaces": createWorkspaces,
  "20261011160100_add_workspace_to_customer_data": addWorkspaceToCustomerData,
  "20261011160200_prepare_users_for_accounts": prepareUsersForAccounts,
  "20261011170000_create_instance_settings": createInstanceSettings,
  "20261011170100_create_rate_limits": createRateLimits,
  "20261011170200_add_instance_admin_flag_to_users":
    addInstanceAdminFlagToUsers,
};

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations;
  },
};
