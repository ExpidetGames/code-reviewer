// SPDX-License-Identifier: LicenseRef-Proprietary

// The calls to GitHub that are made with the USER token of the GitHub App (the token a person gets from the App's
// user authorization), for the binding of an installation to a workspace (docs/decisions/0001-editions-setup-and-
// accounts.md, section 2.9): which GitHub account the token belongs to, which installations the person can use,
// and the person's role in an organization. The token is a parameter of every call and lives only for the
// duration of the call that made it: nothing here stores, logs or returns it, and a message never quotes a
// response body or a header.
//
// Every call answers with a value that says what happened, never with an exception: the caller decides what a
// failure means (fail closed). A 401 is "the authorization is not valid (any more)", which is a different
// thing from "GitHub could not be asked".
import { isRecord } from "./guards.ts";

const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_TIMEOUT_MS = 10_000;
/** A hard stop so a misbehaving server cannot loop us forever. */
const MAX_PAGES = 20;
const PAGE_SIZE = 100;

export type UserRequestOptions = {
  /** API base URL without a trailing slash. */
  apiBaseUrl: string;
  /** Default: the global fetch at call time. */
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/** How a call with a user token can fail: the authorization is no good, or GitHub could not be asked. */
export type UserRequestFailure = "authorization_invalid" | "unavailable";

export type GithubUser = { id: number; login: string };

export type UserInstallation = {
  /** The installation id as text. */
  id: string;
  accountLogin: string;
  accountId: number;
  /** `User` or `Organization`. */
  accountType: string;
  suspended: boolean;
};

/**
 * The role of the person in an organization, read with the user token:
 * - `admin`: an active member whose role is `admin`, which is what GitHub calls an owner;
 * - `member`: any other role, or an invitation that was not accepted;
 * - `not_a_member`: GitHub answers 404 (the person does not belong to the organization);
 * - `unreadable`: GitHub refuses the read (403: the App lacks the permission "Members") or answers something
 *   the app cannot read; `detail` is a stable code.
 */
export type OrganizationRole =
  | { kind: "admin" }
  | { kind: "member" }
  | { kind: "not_a_member" }
  | { kind: "unreadable"; detail: "forbidden" | "unexpected" };

function headers(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": GITHUB_API_VERSION,
    "user-agent": "code-reviewer",
  };
}

type Answer =
  | { kind: "ok"; json: unknown }
  | { kind: "status"; status: number }
  | { kind: "unavailable" };

async function get(
  options: UserRequestOptions,
  token: string,
  path: string,
): Promise<Answer> {
  const doFetch = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await doFetch(`${options.apiBaseUrl}${path}`, {
      method: "GET",
      headers: headers(token),
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch {
    // The cause is dropped on purpose: it can quote the request.
    return { kind: "unavailable" };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return response.status >= 500 || response.status === 429
      ? { kind: "unavailable" }
      : { kind: "status", status: response.status };
  }
  try {
    return { kind: "ok", json: await response.json() };
  } catch {
    return { kind: "unavailable" };
  }
}

/** Whose token it is: `GET /user`. */
export async function readUser(
  options: UserRequestOptions,
  token: string,
): Promise<
  { ok: true; user: GithubUser } | { ok: false; error: UserRequestFailure }
> {
  const answer = await get(options, token, "/user");
  if (answer.kind === "unavailable") return { ok: false, error: "unavailable" };
  if (answer.kind === "status")
    return {
      ok: false,
      error:
        answer.status === 401 || answer.status === 403
          ? "authorization_invalid"
          : "unavailable",
    };
  const { json } = answer;
  if (
    !isRecord(json) ||
    typeof json.id !== "number" ||
    !Number.isSafeInteger(json.id) ||
    typeof json.login !== "string" ||
    json.login === ""
  )
    return { ok: false, error: "unavailable" };
  return { ok: true, user: { id: json.id, login: json.login } };
}

/**
 * Every installation of the App that the token's user can use (`GET /user/installations`, all pages). An
 * incomplete listing is a failure: a list cut short would make an installation look as if the person had no
 * access to it (or, in the picker, hide it).
 */
export async function listUserInstallations(
  options: UserRequestOptions,
  token: string,
): Promise<
  | { ok: true; installations: UserInstallation[] }
  | { ok: false; error: UserRequestFailure }
> {
  const installations: UserInstallation[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const answer = await get(
      options,
      token,
      `/user/installations?per_page=${String(PAGE_SIZE)}&page=${String(page)}`,
    );
    if (answer.kind === "unavailable")
      return { ok: false, error: "unavailable" };
    if (answer.kind === "status")
      return {
        ok: false,
        error:
          answer.status === 401 || answer.status === 403
            ? "authorization_invalid"
            : "unavailable",
      };
    const { json } = answer;
    if (!isRecord(json) || !Array.isArray(json.installations))
      return { ok: false, error: "unavailable" };
    for (const item of json.installations) {
      if (!isRecord(item) || typeof item.id !== "number")
        return { ok: false, error: "unavailable" };
      const account = item.account;
      // A record without a login or a type (some enterprise accounts) is left out: it could not be judged.
      if (
        !isRecord(account) ||
        typeof account.login !== "string" ||
        typeof account.id !== "number" ||
        typeof account.type !== "string"
      )
        continue;
      installations.push({
        id: String(item.id),
        accountLogin: account.login,
        accountId: account.id,
        accountType: account.type,
        suspended: typeof item.suspended_at === "string",
      });
    }
    if (json.installations.length < PAGE_SIZE)
      return { ok: true, installations };
  }
  return { ok: false, error: "unavailable" };
}

const ORGANIZATION_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;

/**
 * The role of the token's user in an organization (`GET /user/memberships/orgs/{org}`, which the organization
 * permission "Members" of the App allows). Only an active `admin` is an owner. A failure to ask is a failure
 * (`unavailable`); a refusal or an answer that cannot be read is `unreadable`, which the binding turns into a
 * request for the instance admin.
 */
export async function readOrganizationRole(
  options: UserRequestOptions,
  token: string,
  organization: string,
): Promise<
  | { ok: true; role: OrganizationRole }
  | { ok: false; error: UserRequestFailure }
> {
  if (!ORGANIZATION_LOGIN.test(organization))
    return { ok: true, role: { kind: "unreadable", detail: "unexpected" } };
  const answer = await get(
    options,
    token,
    `/user/memberships/orgs/${encodeURIComponent(organization)}`,
  );
  if (answer.kind === "unavailable") return { ok: false, error: "unavailable" };
  if (answer.kind === "status") {
    if (answer.status === 401)
      return { ok: false, error: "authorization_invalid" };
    if (answer.status === 404)
      return { ok: true, role: { kind: "not_a_member" } };
    return {
      ok: true,
      role: {
        kind: "unreadable",
        detail: answer.status === 403 ? "forbidden" : "unexpected",
      },
    };
  }
  const { json } = answer;
  if (
    !isRecord(json) ||
    typeof json.role !== "string" ||
    typeof json.state !== "string"
  )
    return { ok: true, role: { kind: "unreadable", detail: "unexpected" } };
  return {
    ok: true,
    role:
      json.state === "active" && json.role === "admin"
        ? { kind: "admin" }
        : { kind: "member" },
  };
}
