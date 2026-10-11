// Starting a review by hand: which pull requests a person can pick, and the start itself. The start
// follows the same rules as the other triggers (an active project, a command the project allows) and
// asks the platform, never the browser, for the facts of the pull request: whether it is open and
// which commit is its head. The job goes through the same queue intake as every other trigger, as a
// `manual` job with the person's login; the queue returns the waiting or running job instead of a
// second one, and a manual job is due at once (no debounce).
import type { IntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import type { RepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import {
  IntegrationError,
  type IntegrationErrorCode,
} from "../integrations/errors.ts";
import type { IntegrationRegistry } from "../integrations/registry.ts";
import type {
  Integration,
  PullRequestRef,
  RepoRef,
  ReviewCommand,
} from "../integrations/types.ts";
import { JobQueueError } from "../jobs/errors.ts";
import type { JobQueue } from "../jobs/job-queue.ts";
import type { ProjectService } from "../projects/service.ts";
import type { ReviewSettingsService } from "../review-settings/service.ts";
import { REVIEW_COMMANDS } from "../integrations/types.ts";
import { ManualReviewError, type ManualReviewIssue } from "./errors.ts";
import { validateStartInput } from "./start-input.ts";

/** A pull request as the picker shows it. Only these fields leave the server. */
export type PullRequestChoice = {
  number: number;
  /** Untrusted text from the pull request; only ever rendered as text. */
  title: string;
  url: string;
  /** The login of the author. Untrusted text. */
  author: string;
  draft: boolean;
  headRef: string;
  baseRef: string;
};

export type OpenPullRequests = {
  repositoryId: string;
  fullName: string;
  /** The commands the project allows, in the order of `REVIEW_COMMANDS`. */
  allowedCommands: ReviewCommand[];
  /** Newest first (highest number first). */
  pullRequests: PullRequestChoice[];
};

export type StartedReview = {
  /** The id of the job, which is the id of its run. */
  runId: string;
  /** False when a waiting or running job for the same pull request and command was returned. */
  created: boolean;
  prNumber: number;
  command: ReviewCommand;
};

export type ManualReviewService = {
  /**
   * The open pull requests of an active project's repository (drafts included), every page. Throws a
   * `ManualReviewError`: `MANUAL_REVIEW_PROJECT_NOT_FOUND`, `MANUAL_REVIEW_APP_NOT_INSTALLED` or
   * `MANUAL_REVIEW_GITHUB_UNAVAILABLE`.
   */
  listOpenPullRequests(repositoryId: string): Promise<OpenPullRequests>;
  /**
   * Starts a review (or another command) for an open pull request. `input` is the body as received
   * and is checked here. Throws a `ManualReviewError`.
   */
  startReview(
    user: { githubLogin: string },
    repositoryId: string,
    input: unknown,
  ): Promise<StartedReview>;
};

export type ManualReviewDependencies = {
  repositories: Pick<RepositoriesRepository, "get">;
  integrations: Pick<IntegrationsRepository, "get">;
  projects: Pick<ProjectService, "getActiveProjectForRepository">;
  settings: Pick<ReviewSettingsService, "resolveForRepository">;
  registry: Pick<IntegrationRegistry, "resolve">;
  queue: Pick<JobQueue, "enqueue">;
  /** One line per started review; never carries a question or a token. */
  log?: (line: string) => void;
};

const MAX_ID_LENGTH = 128;

const NOT_FOUND = () =>
  new ManualReviewError(
    "MANUAL_REVIEW_PROJECT_NOT_FOUND",
    "There is no active project for this repository.",
  );
const NOT_INSTALLED = () =>
  new ManualReviewError(
    "MANUAL_REVIEW_APP_NOT_INSTALLED",
    "The app is not installed for this repository any more, or GitHub refuses it access.",
  );
const UNAVAILABLE = () =>
  new ManualReviewError(
    "MANUAL_REVIEW_GITHUB_UNAVAILABLE",
    "GitHub could not be asked, or answered with something unusable.",
  );

/** The codes of an access failure that mean the app has no (more) access to the repository. */
const NO_ACCESS_CODES: readonly IntegrationErrorCode[] = [
  "INTEGRATION_ACCESS_CONNECTION_GONE",
  "INTEGRATION_ACCESS_CONNECTION_SUSPENDED",
  "INTEGRATION_ACCESS_APP_AUTH_FAILED",
  "INTEGRATION_ACCESS_SCOPE_REFUSED",
];

/** What went wrong while asking the platform, as an error of this module. */
function platformFailure(error: unknown): ManualReviewError {
  if (error instanceof ManualReviewError) return error;
  if (error instanceof IntegrationError && NO_ACCESS_CODES.includes(error.code))
    return NOT_INSTALLED();
  return UNAVAILABLE();
}

function toChoice(pr: PullRequestRef): PullRequestChoice {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author.login,
    draft: pr.draft,
    headRef: pr.headRef,
    baseRef: pr.baseRef,
  };
}

export function createManualReviewService(
  deps: ManualReviewDependencies,
): ManualReviewService {
  const log = deps.log ?? ((line) => console.info(line));

  /**
   * The repository, its integration and the settings of its active project, or the refusal. An
   * integration the platform removed or suspended is "not installed", checked before the project:
   * the project query does not see a disabled integration at all.
   */
  async function resolveProject(repositoryId: string): Promise<{
    integration: Integration;
    repo: RepoRef;
    allowedCommands: ReviewCommand[];
  }> {
    if (
      typeof repositoryId !== "string" ||
      repositoryId.trim() === "" ||
      repositoryId.length > MAX_ID_LENGTH
    )
      throw new ManualReviewError(
        "MANUAL_REVIEW_REQUEST_INVALID",
        "The repository id is missing or malformed.",
      );
    const repository = await deps.repositories.get(repositoryId);
    if (repository === undefined) throw NOT_FOUND();
    const integration = await deps.integrations.get(repository.integrationId);
    if (integration === undefined) throw NOT_FOUND();
    if (integration.status === "disabled") throw NOT_INSTALLED();
    const project = await deps.projects.getActiveProjectForRepository(
      repository.id,
    );
    if (project === undefined) throw NOT_FOUND();
    const resolved = await deps.settings.resolveForRepository(repository.id);
    if (resolved === undefined) throw NOT_FOUND();
    return {
      integration,
      repo: {
        integrationId: repository.integrationId,
        externalId: repository.externalId,
        fullName: repository.fullName,
        url: repository.url,
      },
      allowedCommands: REVIEW_COMMANDS.filter((command) =>
        resolved.settings.allowedCommands.includes(command),
      ),
    };
  }

  return {
    async listOpenPullRequests(repositoryId) {
      const { integration, repo, allowedCommands } =
        await resolveProject(repositoryId);
      let open: PullRequestRef[];
      try {
        open = await deps.registry
          .resolve(integration.type)
          .listOpenPullRequests(integration, repo);
      } catch (error) {
        throw platformFailure(error);
      }
      return {
        repositoryId,
        fullName: repo.fullName,
        allowedCommands,
        pullRequests: open
          .filter((pr) => pr.state === "open")
          .sort((a, b) => b.number - a.number)
          .map(toChoice),
      };
    },

    async startReview(user, repositoryId, input) {
      const checked = validateStartInput(input);
      if (!checked.ok)
        throw new ManualReviewError(
          "MANUAL_REVIEW_REQUEST_INVALID",
          "The request is not valid.",
          checked.issues as readonly ManualReviewIssue[],
        );
      const { prNumber, command, question } = checked.value;

      const { integration, repo, allowedCommands } =
        await resolveProject(repositoryId);
      if (!allowedCommands.includes(command))
        throw new ManualReviewError(
          "MANUAL_REVIEW_COMMAND_NOT_ALLOWED",
          "The project does not allow this command.",
        );

      // The platform decides what the pull request is: the browser only names a number.
      let pullRequest: PullRequestRef;
      try {
        pullRequest = await deps.registry
          .resolve(integration.type)
          .getPullRequest(integration, repo, prNumber);
      } catch (error) {
        if (
          error instanceof IntegrationError &&
          error.code === "INTEGRATION_PULL_REQUEST_NOT_FOUND"
        )
          throw new ManualReviewError(
            "MANUAL_REVIEW_PULL_REQUEST_NOT_FOUND",
            "The repository has no pull request with this number.",
          );
        throw platformFailure(error);
      }
      if (pullRequest.state !== "open")
        throw new ManualReviewError(
          "MANUAL_REVIEW_PULL_REQUEST_NOT_OPEN",
          "The pull request is closed or merged.",
        );

      let result;
      try {
        result = await deps.queue.enqueue({
          repositoryId,
          prNumber: pullRequest.number,
          prUrl: pullRequest.url,
          headSha: pullRequest.headSha,
          command,
          args: question,
          triggerKind: "manual",
          actorLogin: user.githubLogin,
        });
      } catch (error) {
        // The queue refuses what it was given (a question that is too long is caught before; this is
        // the safety net for the rest). Asking again will not help, and nothing was written.
        if (
          error instanceof JobQueueError &&
          error.code === "JOB_INPUT_INVALID"
        )
          throw new ManualReviewError(
            "MANUAL_REVIEW_REQUEST_INVALID",
            "The job queue did not accept the request.",
          );
        throw error;
      }
      log(
        `[manual-review] job ${result.status} job=${result.job.id} repo=${repo.fullName} pr=${prNumber} command=${command} by=${user.githubLogin}`,
      );
      return {
        runId: result.job.id,
        created: result.status === "created",
        prNumber,
        command,
      };
    },
  };
}
