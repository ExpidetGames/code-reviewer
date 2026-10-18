// SPDX-License-Identifier: Apache-2.0

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
import { migration as createSecrets } from "./20261011200000_create_secrets.ts";
import { migration as createPasswordResetTokens } from "./20261011200100_create_password_reset_tokens.ts";
import { migration as createEmailVerificationTokens } from "./20261011210000_create_email_verification_tokens.ts";
import { migration as createInvitations } from "./20261012100000_create_invitations.ts";
import { migration as createSignedStates } from "./20261012120000_create_signed_states.ts";
import { migration as addUsersEmailConflict } from "./20261012120100_add_users_email_conflict.ts";
import { migration as uniqueAccounts } from "./20261012120200_unique_accounts.ts";
import { migration as createWorkspaceSecrets } from "./20261012140000_create_workspace_secrets.ts";
import { migration as createJobClaimedKeys } from "./20261012140100_create_job_claimed_keys.ts";
import { migration as createInstallationBinding } from "./20261012150000_create_installation_binding.ts";
import { migration as removeCommands } from "./20261012160000_remove_commands.ts";
import { migration as addJobReviewKind } from "./20261013090000_add_job_review_kind.ts";
import { migration as fixDynamicDefaultModel } from "./20261014090000_fix_dynamic_default_model.ts";
import { migration as createWorkspaceEntitlements } from "./20261014120000_create_workspace_entitlements.ts";
import { migration as createUsageRecords } from "./20261014150000_create_usage_records.ts";
import { migration as createJobCheckRuns } from "./20261017100000_create_job_check_runs.ts";
import { migration as addJobAcceptsSupersede } from "./20261016140000_add_job_accepts_supersede.ts";
import { migration as widenUsageRecordSettledReason } from "./20261016140100_widen_usage_record_settled_reason.ts";
import { migration as addJobWorkerFetches } from "./20261015100000_add_job_worker_fetches.ts";
import { migration as createSetupCodes } from "./20261015110000_create_setup_codes.ts";
import { migration as createJobDispatches } from "./20261015120000_create_job_dispatches.ts";
import { migration as addUsageRecordSettledReason } from "./20261015200000_add_usage_record_settled_reason.ts";
import { migration as createRefusalNotices } from "./20261016090000_create_refusal_notices.ts";
import { migration as createPlanHandoffTokens } from "./20261016120000_create_plan_handoff_tokens.ts";
import { migration as createModelCatalogEntries } from "./20261017140000_create_model_catalog_entries.ts";
import { migration as addWorkspaceEntitlementsModelAccess } from "./20261017160000_add_workspace_entitlements_model_access.ts";
import { migration as createBillingPlans } from "./20261018120000_create_billing_plans.ts";

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
  "20261011200000_create_secrets": createSecrets,
  "20261011200100_create_password_reset_tokens": createPasswordResetTokens,
  "20261011210000_create_email_verification_tokens":
    createEmailVerificationTokens,
  "20261012100000_create_invitations": createInvitations,
  "20261012120000_create_signed_states": createSignedStates,
  "20261012120100_add_users_email_conflict": addUsersEmailConflict,
  "20261012120200_unique_accounts": uniqueAccounts,
  "20261012140000_create_workspace_secrets": createWorkspaceSecrets,
  "20261012140100_create_job_claimed_keys": createJobClaimedKeys,
  "20261012150000_create_installation_binding": createInstallationBinding,
  "20261012160000_remove_commands": removeCommands,
  "20261013090000_add_job_review_kind": addJobReviewKind,
  "20261014090000_fix_dynamic_default_model": fixDynamicDefaultModel,
  "20261014120000_create_workspace_entitlements": createWorkspaceEntitlements,
  "20261014150000_create_usage_records": createUsageRecords,
  "20261015100000_add_job_worker_fetches": addJobWorkerFetches,
  "20261015110000_create_setup_codes": createSetupCodes,
  "20261015120000_create_job_dispatches": createJobDispatches,
  "20261015200000_add_usage_record_settled_reason": addUsageRecordSettledReason,
  "20261016090000_create_refusal_notices": createRefusalNotices,
  "20261016120000_create_plan_handoff_tokens": createPlanHandoffTokens,
  "20261016140000_add_job_accepts_supersede": addJobAcceptsSupersede,
  "20261016140100_widen_usage_record_settled_reason":
    widenUsageRecordSettledReason,
  "20261017100000_create_job_check_runs": createJobCheckRuns,
  "20261017140000_create_model_catalog_entries": createModelCatalogEntries,
  "20261017160000_add_workspace_entitlements_model_access":
    addWorkspaceEntitlementsModelAccess,
  "20261018120000_create_billing_plans": createBillingPlans,
};

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations;
  },
};
