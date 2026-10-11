// The GitHub App as an IntegrationProvider: one installation of our own app is one integration.
// Everything GitHub specific stays in this folder; the rest of the app sees normalized types only.
// See ../../README.md.
import {
  validateConfigAgainstSchema,
  type ConfigSchema,
} from "../../config-schema.ts";
import { IntegrationError } from "../../errors.ts";
import { createGitAccess } from "../../normalized.ts";
import type { IntegrationProvider } from "../../provider.ts";
import type { DiscoveredConnection, RepoRef } from "../../types.ts";
import {
  createGithubAppClient,
  type GithubAppClient,
  type GithubAppClientOptions,
  type RemoteInstallation,
} from "./client.ts";
import type { GithubAppConfig } from "./config.ts";
import { GithubAppError } from "./errors.ts";
import { parseGithubEvent } from "./events.ts";
import {
  JOB_TOKEN_PERMISSIONS,
  jobTokenRepositoryIds,
  toJobAccessError,
  toReadError,
} from "./job-access.ts";
import { isValidSignature } from "./webhook-signature.ts";
import { field, payloadProblems } from "./webhook-fields.ts";

const CONFIG_SCHEMA: ConfigSchema = {
  accountLogin: { type: "string" },
  accountId: { type: "number" },
  accountType: { type: "string" },
};

export type GithubAppProviderOptions = {
  /**
   * The settings, or a function that reads them on first use. The provider is created when the app
   * loads, so a missing variable must not break anything else: it fails the first call that needs
   * GitHub, with GITHUB_APP_CONFIG_INVALID, and works again once the variables are fixed.
   */
  config: GithubAppConfig | (() => GithubAppConfig);
  /** Replaces the HTTP client; for unit tests. */
  client?: GithubAppClient;
  /** Passed to the default client (a different fetch, clock or timeout). */
  clientOptions?: Omit<GithubAppClientOptions, "config">;
};

function toDiscovered(installation: RemoteInstallation): DiscoveredConnection {
  return {
    externalId: installation.id,
    displayName: installation.accountLogin,
    config: {
      accountLogin: installation.accountLogin,
      accountId: installation.accountId,
      accountType: installation.accountType,
    },
    suspended: installation.suspended,
  };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.clone().json();
  } catch {
    return undefined;
  }
}

export function createGithubAppProvider(
  options: GithubAppProviderOptions,
): IntegrationProvider {
  let resolvedConfig: GithubAppConfig | undefined;
  let resolvedClient: GithubAppClient | undefined;

  // Only a successful load is remembered, so fixing the environment needs no restart of this object.
  function getConfig(): GithubAppConfig {
    if (resolvedConfig) return resolvedConfig;
    resolvedConfig =
      typeof options.config === "function" ? options.config() : options.config;
    return resolvedConfig;
  }

  function getClient(): GithubAppClient {
    // Reading the settings first makes an injected client fail like the real one when they are bad.
    const config = getConfig();
    resolvedClient ??=
      options.client ??
      createGithubAppClient({ ...options.clientOptions, config });
    return resolvedClient;
  }

  async function hasWriteAccess(
    installationId: string,
    repoFullName: string,
    login: string,
  ): Promise<boolean> {
    const permission = await getClient().getCollaboratorPermission(
      installationId,
      repoFullName,
      login,
    );
    return permission === "admin" || permission === "write";
  }

  return {
    type: "github_app",
    connect: { kind: "install_redirect" },

    validateConfig(config) {
      return validateConfigAgainstSchema(CONFIG_SCHEMA, config);
    },

    async discoverConnections() {
      return (await getClient().listInstallations()).map(toDiscovered);
    },

    async findConnection(externalId) {
      const installation = await getClient().getInstallation(externalId);
      return installation === null ? null : toDiscovered(installation);
    },

    async listRepositories(integration) {
      const remote = await getClient().listInstallationRepositories(
        integration.externalId,
      );
      return remote.map((repo): RepoRef => ({
        integrationId: integration.id,
        externalId: repo.externalId,
        fullName: repo.fullName,
        url: repo.url,
      }));
    },

    async verifyWebhook(_integration, request) {
      // The bytes as received, not decoded text: the signature covers exactly these.
      const body = new Uint8Array(await request.clone().arrayBuffer());
      return isValidSignature(
        body,
        request.headers.get("x-hub-signature-256"),
        getConfig().webhookSecret,
      );
    },

    async identifyWebhook(request) {
      const payload = await readJson(request);
      if (payloadProblems("installation", payload).includes("installation.id"))
        return null;
      return { externalId: String(field<number>(payload, "installation.id")) };
    },

    async parseEvent(integration, request) {
      const payload = await readJson(request);
      if (payload === undefined)
        return { kind: "ignored", reason: "the body is not valid JSON" };
      return parseGithubEvent({
        integrationId: integration.id,
        eventName: request.headers.get("x-github-event") ?? "",
        payload,
        hasWriteAccess: (repoFullName, login) =>
          hasWriteAccess(integration.externalId, repoFullName, login),
        async headShaOf(repoFullName, prNumber) {
          const pr = await getClient().getPullRequest(
            integration.externalId,
            repoFullName,
            prNumber,
          );
          return pr.headSha;
        },
      });
    },

    async canTrigger(integration, trigger) {
      // Pull request events start a review whoever caused them (forks included).
      if (trigger.kind !== "command") return true;
      return hasWriteAccess(
        integration.externalId,
        trigger.repo.fullName,
        trigger.actor.login,
      );
    },

    async jobAccess(integration, repo) {
      // A fresh token for exactly this repository on every call, never cached or shared between
      // jobs. A failure is an IntegrationError with a stable code; nothing broader is tried instead.
      try {
        const config = getConfig();
        const repositoryIds = jobTokenRepositoryIds(repo.externalId);
        if (repo.integrationId !== integration.id || repositoryIds === null)
          throw new IntegrationError(
            "INTEGRATION_ACCESS_SCOPE_REFUSED",
            "The repository does not belong to this integration or has no usable id.",
          );
        const minted = await getClient().mintInstallationToken(
          integration.externalId,
          { repositoryIds, permissions: JOB_TOKEN_PERMISSIONS },
        );
        return createGitAccess({
          provider: "github",
          baseUrl: config.apiBaseUrl,
          token: minted.token,
          authType: "token",
          botLogin: `${config.slug}[bot]`,
          expiresAt: minted.expiresAt,
        });
      } catch (error) {
        throw toJobAccessError(error);
      }
    },

    async getPullRequest(integration, repo, prNumber) {
      try {
        return await getClient().getPullRequest(
          integration.externalId,
          repo.fullName,
          prNumber,
        );
      } catch (error) {
        // A 404 of the call itself is a pull request that does not exist; a 404 of the token request
        // is an installation that is gone, which `toReadError` reports as such. Everything else
        // leaves as a provider neutral code too.
        if (
          error instanceof GithubAppError &&
          error.code === "GITHUB_APP_NOT_FOUND" &&
          !error.duringTokenRequest
        )
          throw new IntegrationError(
            "INTEGRATION_PULL_REQUEST_NOT_FOUND",
            `Pull request ${prNumber} does not exist in ${repo.fullName}.`,
            { cause: error },
          );
        throw toReadError(error);
      }
    },

    async listOpenPullRequests(integration, repo) {
      // Failures leave as provider neutral codes (the installation is gone, access is refused, GitHub
      // is down), so the page that lists the pull requests never has to know GitHub's error codes.
      try {
        return await getClient().listOpenPullRequests(
          integration.externalId,
          repo.fullName,
        );
      } catch (error) {
        throw toReadError(error);
      }
    },
  };
}
