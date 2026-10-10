// The interface behind which everything platform specific lives. Jobs, the runner API and the UI
// call these methods and see normalized types only. See README.md in this folder.
import type { ConfigValidationResult } from "./config-schema.ts";
import type {
  GitAccess,
  Integration,
  IntegrationType,
  RepoRef,
  ReviewTrigger,
} from "./types.ts";

/** How a user connects this kind of integration. */
export const CONNECT_FLOW_KINDS = [
  "install_redirect",
  "oauth",
  "token_form",
] as const;
export type ConnectFlow = { kind: (typeof CONNECT_FLOW_KINDS)[number] };

export interface IntegrationProvider {
  readonly type: IntegrationType;
  readonly connect: ConnectFlow;

  /** Checks a config from the user or the platform. One error per offending field. */
  validateConfig(config: unknown): ConfigValidationResult;

  listRepositories(integration: Integration): Promise<RepoRef[]>;

  /** Only where webhooks are per repository: creates the webhook if it is missing. */
  ensureWebhook?(integration: Integration, repo: RepoRef): Promise<void>;

  /**
   * Checks the signature of a delivery. `integration` is null for platforms with one shared
   * webhook (GitHub App). Reads a clone of the request; the caller can still read the body.
   */
  verifyWebhook(
    integration: Integration | null,
    request: Request,
  ): Promise<boolean>;

  /** Translates a verified delivery into a trigger, or null if it is not relevant for reviews. */
  parseEvent(
    integration: Integration,
    request: Request,
  ): Promise<ReviewTrigger | null>;

  /**
   * May this trigger start a job? About the trigger only (for example: has the comment author write
   * access), not about the app's own permissions on the platform.
   */
  canTrigger(
    integration: Integration,
    trigger: ReviewTrigger,
  ): Promise<boolean>;

  /** Credentials for one job on one repository; short-lived where the platform allows it. */
  jobAccess(integration: Integration, repo: RepoRef): Promise<GitAccess>;
}
