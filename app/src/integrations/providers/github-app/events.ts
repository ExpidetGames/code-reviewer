// Translates a verified GitHub delivery into what it means for the app (an IntegrationEvent). Reads
// only the fields listed in `webhook-fields.ts`. A delivery that is genuine but of no interest, or
// whose payload does not have the expected shape, is `ignored` with a reason for the logs.
import type {
  InstallationAction,
  IntegrationEvent,
  ReviewCommand,
  ReviewTrigger,
} from "../../types.ts";
import {
  field,
  hasField,
  isReadWebhookEvent,
  payloadProblems,
} from "./webhook-fields.ts";

/** GitHub's `installation` actions that matter, and what they mean for the app. */
const INSTALLATION_ACTION_MAP: Record<string, InstallationAction> = {
  created: "created",
  deleted: "deleted",
  suspend: "suspended",
  unsuspend: "unsuspended",
};

/** Pull request actions that start a review, and which kind of trigger they are. */
const PULL_REQUEST_TRIGGER_MAP = {
  opened: "opened",
  reopened: "opened",
  ready_for_review: "opened",
  synchronize: "updated",
} as const;

// A command counts only if the comment starts with it (leading whitespace allowed), in any case.
const COMMAND_PATTERN =
  /^\s*\/(review|improve|describe|ask)(?=\s|$)\s*([\s\S]*)$/i;

export type ParseContext = {
  integrationId: string;
  /** The event name from the `X-GitHub-Event` header. */
  eventName: string;
  payload: unknown;
  /** The current head commit of a pull request; a comment delivery does not carry it. */
  headShaOf(repoFullName: string, prNumber: number): Promise<string>;
};

function ignored(reason: string): IntegrationEvent {
  return { kind: "ignored", reason };
}

function repoOf(context: ParseContext) {
  const { payload } = context;
  return {
    integrationId: context.integrationId,
    externalId: String(field<number>(payload, "repository.id")),
    fullName: field<string>(payload, "repository.full_name"),
    url: field<string>(payload, "repository.html_url"),
  };
}

function actorOf(payload: unknown) {
  return {
    login: field<string>(payload, "sender.login"),
    externalId: String(field<number>(payload, "sender.id")),
  };
}

export async function parseGithubEvent(
  context: ParseContext,
): Promise<IntegrationEvent> {
  const { eventName, payload } = context;
  if (!isReadWebhookEvent(eventName))
    return ignored(`the event "${eventName}" is not used`);

  const problems = payloadProblems(eventName, payload);
  if (problems.length > 0)
    return ignored(
      `the "${eventName}" payload lacks the expected fields: ${problems.join(", ")}`,
    );

  const action = field<string>(payload, "action");

  if (eventName === "installation") {
    const mapped = INSTALLATION_ACTION_MAP[action];
    if (mapped === undefined)
      return ignored(`the installation action "${action}" is not used`);
    return {
      kind: "installation_changed",
      externalId: String(field<number>(payload, "installation.id")),
      action: mapped,
    };
  }

  if (eventName === "installation_repositories") {
    if (action !== "added" && action !== "removed")
      return ignored(`the repositories action "${action}" is not used`);
    return {
      kind: "installation_changed",
      externalId: String(field<number>(payload, "installation.id")),
      action: "repositories_changed",
    };
  }

  if (eventName === "pull_request") {
    if (!Object.hasOwn(PULL_REQUEST_TRIGGER_MAP, action))
      return ignored(
        `the pull request action "${action}" does not start a review`,
      );
    const kind =
      PULL_REQUEST_TRIGGER_MAP[action as keyof typeof PULL_REQUEST_TRIGGER_MAP];
    const trigger: ReviewTrigger = {
      kind,
      repo: repoOf(context),
      prNumber: field<number>(payload, "number"),
      prUrl: field<string>(payload, "pull_request.html_url"),
      headSha: field<string>(payload, "pull_request.head.sha"),
      command: null,
      args: null,
      actor: actorOf(payload),
    };
    return { kind: "review_trigger", trigger };
  }

  // issue_comment
  if (action !== "created")
    return ignored(`the comment action "${action}" is not used`);
  if (!hasField(payload, "issue.pull_request"))
    return ignored("the comment is on an issue, not on a pull request");
  if (field<string>(payload, "issue.state") !== "open")
    return ignored("the pull request is not open");
  if (field<string>(payload, "sender.type") === "Bot")
    return ignored("the comment was written by a bot");

  const match = COMMAND_PATTERN.exec(field<string>(payload, "comment.body"));
  if (match === null) return ignored("the comment is not a command");

  const repo = repoOf(context);
  const prNumber = field<number>(payload, "issue.number");
  return {
    kind: "review_trigger",
    trigger: {
      kind: "command",
      repo,
      prNumber,
      prUrl: `${repo.url}/pull/${prNumber}`,
      headSha: await context.headShaOf(repo.fullName, prNumber),
      command: (match[1] as string).toLowerCase() as ReviewCommand,
      args: (match[2] ?? "").trim(),
      actor: actorOf(payload),
    },
  };
}
