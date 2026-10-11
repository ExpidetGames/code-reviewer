// The interface behind which everything platform specific lives. Jobs, the runner API and the UI
// call these methods and see normalized types only. See README.md in this folder.
import type { ConfigValidationResult } from "./config-schema.ts";
import type {
  DiscoveredConnection,
  GitAccess,
  Integration,
  IntegrationEvent,
  IntegrationType,
  PullRequestRef,
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

  /**
   * Only where the platform can list the connections of this app (GitHub App: the installations).
   * The sync creates, updates and disables `integrations` rows from it. Rejects when the platform
   * cannot be asked, so a failure is never mistaken for "there are no connections".
   */
  discoverConnections?(): Promise<DiscoveredConnection[]>;

  /**
   * Only together with `discoverConnections`: asks the platform whether one connection exists, and
   * returns its details or null when the platform does not know it. This is how a "connection
   * created" delivery for a connection without a row is verified before a row is created.
   */
  findConnection?(externalId: string): Promise<DiscoveredConnection | null>;

  /** Every repository of the connection the app may see. Rejects when it cannot list all of them. */
  listRepositories(integration: Integration): Promise<RepoRef[]>;

  /** Only where webhooks are per repository: creates the webhook if it is missing. */
  ensureWebhook?(integration: Integration, repo: RepoRef): Promise<void>;

  /**
   * Checks the signature of a delivery. `integration` is null for platforms with one shared
   * webhook (GitHub App), where the connection is only known after `identifyWebhook`. Reads a clone
   * of the request: the caller can still read the body afterwards.
   */
  verifyWebhook(
    integration: Integration | null,
    request: Request,
  ): Promise<boolean>;

  /**
   * For a shared webhook: which connection does this delivery belong to? The route calls it after
   * `verifyWebhook(null, request)` and looks the row up by `(type, externalId)`. Returns null where
   * the URL already names the connection or the delivery carries no connection id. Reads a clone,
   * has no side effects.
   */
  identifyWebhook(request: Request): Promise<{ externalId: string } | null>;

  /**
   * Translates a verified delivery into what it means for the app: a review trigger, a change of
   * the connection (installed, removed, repositories changed) or nothing of interest. Reads a clone.
   */
  parseEvent(
    integration: Integration,
    request: Request,
  ): Promise<IntegrationEvent>;

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

  /**
   * One pull request of a repository, for example to start a review by hand. When `signal` fires, the
   * request to the platform is aborted (not just no longer waited for) and the call rejects with
   * `INTEGRATION_ACCESS_UNAVAILABLE`.
   */
  getPullRequest(
    integration: Integration,
    repo: RepoRef,
    prNumber: number,
    signal?: AbortSignal,
  ): Promise<PullRequestRef>;

  /** The open pull requests of a repository (drafts included, marked as such). Aborts like `getPullRequest`. */
  listOpenPullRequests(
    integration: Integration,
    repo: RepoRef,
    signal?: AbortSignal,
  ): Promise<PullRequestRef[]>;
}
