// The normalized vocabulary of the app. Jobs, the runner API and the UI depend on these types only;
// they never see a GitHub (or any other platform) payload. See README.md in this folder.

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Stable identifiers of the integration kinds that have an implementation. They are stored in the
 * `integrations.type` column, so a value is never renamed or reused.
 *
 * Reserved for later and deliberately NOT in this set (no implementation, no registry entry):
 *   - "github_token"    GitHub with a fine-grained token, one webhook per repository
 *   - "bitbucket_cloud" Bitbucket Cloud with an access token or OAuth
 * Add a value here only together with its provider (see README.md).
 */
export const INTEGRATION_TYPES = ["github_app"] as const;
export type IntegrationType = (typeof INTEGRATION_TYPES)[number];

/** Documented future types: recognised, but they have no provider yet. */
export const RESERVED_INTEGRATION_TYPES = [
  "github_token",
  "bitbucket_cloud",
] as const;
export type ReservedIntegrationType =
  (typeof RESERVED_INTEGRATION_TYPES)[number];

export function isIntegrationType(value: unknown): value is IntegrationType {
  return INTEGRATION_TYPES.some((type) => type === value);
}

export function isReservedIntegrationType(
  value: unknown,
): value is ReservedIntegrationType {
  return RESERVED_INTEGRATION_TYPES.some((type) => type === value);
}

/**
 * Which secrets a type may keep in its table row. A GitHub App keeps none there: its private key and
 * webhook secret live in the environment of the app. A type that stores credentials adds them here.
 */
export const INTEGRATION_SECRET_STORAGE: Record<
  IntegrationType,
  { credentials: boolean; webhookSecret: boolean }
> = {
  github_app: { credentials: false, webhookSecret: false },
};

export const INTEGRATION_STATUSES = ["active", "disabled"] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

/** A configured connection to a git platform, as stored in the `integrations` table. */
export type Integration = {
  id: string;
  /** The workspace the connection belongs to (a connection belongs to exactly one). */
  workspaceId: string;
  type: IntegrationType;
  displayName: string;
  /** The platform's id for this connection (GitHub App: the installation id). Never empty. */
  externalId: string;
  /** Non-secret settings of the connection. Never holds a key or a token. */
  config: { [key: string]: JsonValue };
  /** Reserved for token integrations; encrypted later. `null` for a GitHub App. */
  credentials: JsonValue | null;
  /** Only for integrations that get their own webhook secret per connection. */
  webhookSecret: string | null;
  status: IntegrationStatus;
  /** ISO 8601 text in UTC. */
  createdAt: string;
  updatedAt: string;
};

/** A repository on the platform, in terms the rest of the app understands. */
export type RepoRef = {
  integrationId: string;
  /** The platform's id of the repository. */
  externalId: string;
  /** "owner/name". */
  fullName: string;
  /** Web URL of the repository. */
  url: string;
};

/** Why a review was asked for. `command` carries a command and its arguments. */
export const REVIEW_TRIGGER_KINDS = ["opened", "updated", "command"] as const;
export type ReviewTriggerKind = (typeof REVIEW_TRIGGER_KINDS)[number];

/** The commands a comment can trigger; the same set the runner accepts. */
export const REVIEW_COMMANDS = [
  "review",
  "improve",
  "describe",
  "ask",
] as const;
export type ReviewCommand = (typeof REVIEW_COMMANDS)[number];

/** The person or bot that caused the event. */
export type TriggerActor = {
  login: string;
  /** The platform's id of the account, if the event carries it. */
  externalId: string | null;
};

type ReviewTriggerBase = {
  repo: RepoRef;
  prNumber: number;
  /** Web URL of the pull request; building it is platform specific, so the provider does it. */
  prUrl: string;
  headSha: string;
  actor: TriggerActor;
};

/** The state of a pull request as a delivery reports it (merged pull requests are `closed`). */
export const TRIGGER_PULL_REQUEST_STATES = ["open", "closed"] as const;
export type TriggerPullRequestState =
  (typeof TRIGGER_PULL_REQUEST_STATES)[number];

export type ReviewTrigger =
  | (ReviewTriggerBase & {
      kind: "opened" | "updated";
      command: null;
      args: null;
      /** The pull request is a draft (work in progress) when the event happened. */
      draft: boolean;
      /**
       * The state of the pull request in the delivery. A late `synchronize` or `reopened` for a pull
       * request that is closed by now carries `closed`; the automatic trigger policy skips it.
       */
      state: TriggerPullRequestState;
    })
  | (ReviewTriggerBase & {
      kind: "command";
      command: ReviewCommand;
      /**
       * The question of `ask`, already cut to its maximum length; an empty string for the other
       * commands, which take no text. Untrusted: it comes from a comment.
       */
      args: string;
      /**
       * The platform's id of the comment that holds the command. The queue starts at most one job
       * per comment, whatever delivery id the same comment arrives under.
       */
      commentId: string;
    });

/** Git platforms the runner knows how to talk to (the runner maps these to PR-Agent settings). */
export const GIT_PLATFORMS = ["github", "bitbucket", "gitlab"] as const;
export type GitPlatform = (typeof GIT_PLATFORMS)[number];

export const GIT_AUTH_TYPES = ["token", "bearer"] as const;
export type GitAuthType = (typeof GIT_AUTH_TYPES)[number];

/**
 * Short-lived credentials for one job on one repository. Never stored, never logged. Build it with
 * `createGitAccess` (normalized.ts): `token` is then not enumerable, so JSON.stringify, spreading and
 * console output leave it out. Only `revealGitAccess` hands the token out, for the runner API.
 */
export type GitAccess = {
  provider: GitPlatform;
  /** API base URL of the platform. */
  baseUrl: string;
  token: string;
  authType: GitAuthType;
  /** Login the bot acts as, when the platform cannot tell it by itself (GitHub App). */
  botLogin: string | null;
  /** ISO 8601 text in UTC; `null` when the token does not expire. */
  expiresAt: string | null;
};

export const PULL_REQUEST_STATES = ["open", "closed", "merged"] as const;
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

/** A pull request as the app needs to know it, for example to start a review by hand. */
export type PullRequestRef = {
  number: number;
  title: string;
  url: string;
  headSha: string;
  /** Name of the branch the pull request merges into. */
  baseRef: string;
  /** Name of the branch the changes come from. */
  headRef: string;
  draft: boolean;
  state: PullRequestState;
  author: TriggerActor;
};

/**
 * A connection the platform itself can enumerate (GitHub App: an installation). Used to create and
 * update `integrations` rows without a user adding them by hand.
 */
export type DiscoveredConnection = {
  /** The platform's id for the connection (GitHub App: the installation id). */
  externalId: string;
  displayName: string;
  /** Non-secret settings, valid for the provider's `validateConfig`. */
  config: { [key: string]: JsonValue };
  /** The platform has paused the connection (GitHub: a suspended installation). */
  suspended: boolean;
};

export const INSTALLATION_ACTIONS = [
  "created",
  "deleted",
  "suspended",
  "unsuspended",
  "repositories_changed",
] as const;
export type InstallationAction = (typeof INSTALLATION_ACTIONS)[number];

/** What a verified delivery means for the app, whatever the platform called it. */
export type IntegrationEvent =
  | { kind: "review_trigger"; trigger: ReviewTrigger }
  /** The connection itself changed (installed, removed, repositories added or removed). */
  | {
      kind: "installation_changed";
      externalId: string;
      action: InstallationAction;
    }
  /**
   * A pull request was closed (merged or not). It starts nothing; the app uses it to drop the jobs
   * that are still waiting for that pull request.
   */
  | {
      kind: "pull_request_closed";
      repo: RepoRef;
      prNumber: number;
      merged: boolean;
    }
  /**
   * A pull request was turned into a draft. It starts nothing; the app drops the pull request's
   * waiting automatic jobs, because a draft is not reviewed automatically.
   */
  | { kind: "pull_request_drafted"; repo: RepoRef; prNumber: number }
  /**
   * A delivery of an event the app uses whose payload lacks fields the app reads (or has them with
   * the wrong type). Nothing can be done with it and a redelivery would not change that; `reason`
   * names the fields for the logs, never their values.
   */
  | { kind: "invalid_payload"; reason: string }
  /** Genuine but of no interest for reviews; `reason` is for logs, never for branching. */
  | { kind: "ignored"; reason: string };
