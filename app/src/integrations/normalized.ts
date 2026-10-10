// Runtime guards for the normalized types. The key sets are exact on purpose: a provider that
// copies a raw platform object into a RepoRef, ReviewTrigger or GitAccess is caught here instead of
// leaking the platform's format into jobs, the runner API or the UI.
import {
  GIT_AUTH_TYPES,
  GIT_PLATFORMS,
  REVIEW_COMMANDS,
  REVIEW_TRIGGER_KINDS,
  type GitAccess,
  type RepoRef,
  type ReviewTrigger,
} from "./types.ts";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return values.some((candidate) => candidate === value);
}

export function isRepoRef(value: unknown): value is RepoRef {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, ["integrationId", "externalId", "fullName", "url"]))
    return false;
  return (
    isNonEmptyString(value.integrationId) &&
    isNonEmptyString(value.externalId) &&
    isNonEmptyString(value.fullName) &&
    isNonEmptyString(value.url)
  );
}

function isActor(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["login", "externalId"]))
    return false;
  return (
    isNonEmptyString(value.login) &&
    (value.externalId === null || isNonEmptyString(value.externalId))
  );
}

export function isReviewTrigger(value: unknown): value is ReviewTrigger {
  if (!isRecord(value)) return false;
  const keys = [
    "kind",
    "repo",
    "prNumber",
    "headSha",
    "command",
    "args",
    "actor",
  ];
  if (!hasExactKeys(value, keys)) return false;
  if (!isOneOf(REVIEW_TRIGGER_KINDS, value.kind)) return false;
  if (!isRepoRef(value.repo) || !isActor(value.actor)) return false;
  if (!Number.isInteger(value.prNumber) || (value.prNumber as number) < 1)
    return false;
  if (!isNonEmptyString(value.headSha)) return false;

  if (value.kind === "command") {
    return (
      isOneOf(REVIEW_COMMANDS, value.command) && typeof value.args === "string"
    );
  }
  return value.command === null && value.args === null;
}

export function isGitAccess(value: unknown): value is GitAccess {
  if (!isRecord(value)) return false;
  const keys = [
    "provider",
    "baseUrl",
    "token",
    "authType",
    "botLogin",
    "expiresAt",
  ];
  if (!hasExactKeys(value, keys)) return false;
  return (
    isOneOf(GIT_PLATFORMS, value.provider) &&
    isOneOf(GIT_AUTH_TYPES, value.authType) &&
    isNonEmptyString(value.baseUrl) &&
    isNonEmptyString(value.token) &&
    (value.botLogin === null || isNonEmptyString(value.botLogin)) &&
    (value.expiresAt === null || isNonEmptyString(value.expiresAt))
  );
}
