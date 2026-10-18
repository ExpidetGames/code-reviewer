// SPDX-License-Identifier: Apache-2.0

// How the pages call the app's own JSON routes (activate a project, save settings, run the sync).
// One function so every call sends the same headers and every failure ends up as a stable code the
// page can translate: nothing here throws. The routes check where a request comes from, so the call
// must come from the page itself (`credentials: "same-origin"`, a JSON body).

export const TRANSPORT_ERROR_CODES = [
  /** The access proxy turned the request away: there is no session (any more). 401. */
  "UNAUTHENTICATED",
  /** The access proxy turned the request away: the signed in person is not on the allow list. 403. */
  "ACCESS_DENIED",
  /** The server could not be reached. */
  "NETWORK_ERROR",
  /** The answer was not what the route documents (not JSON, or an error without a code). */
  "UNEXPECTED_RESPONSE",
] as const;
export type TransportErrorCode = (typeof TRANSPORT_ERROR_CODES)[number];

/** `fetch`, narrowed to what the pages use so a test can hand in a stand-in. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type RequestIssue = { field: string; code: string };

export type RequestResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      /** The HTTP status, or null when there was no answer. */
      status: number | null;
      /** The route's error code or a transport code; a plain string because the routes own theirs. */
      code: string;
      issues: RequestIssue[];
      /** The two values a refusal can carry as text (a price that differs: what was entered and what Paddle says). */
      values?: { entered?: string; paddle?: string };
    };

function failure(
  status: number | null,
  code: string,
  issues: RequestIssue[] = [],
  values?: { entered?: string; paddle?: string },
): RequestResult<never> {
  return {
    ok: false,
    status,
    code,
    issues,
    ...(values === undefined ? {} : { values }),
  };
}

/** `entered` and `paddle` of a refusal, when they are text; any other field of the body is not read. */
function readValues(
  body: object,
): { entered?: string; paddle?: string } | undefined {
  const { entered, paddle } = body as { entered?: unknown; paddle?: unknown };
  const values = {
    ...(typeof entered === "string" ? { entered } : {}),
    ...(typeof paddle === "string" ? { paddle } : {}),
  };
  return Object.keys(values).length === 0 ? undefined : values;
}

function readIssues(value: unknown): RequestIssue[] {
  if (!Array.isArray(value)) return [];
  const issues: RequestIssue[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { field, code } = entry as { field?: unknown; code?: unknown };
    if (typeof field === "string" && typeof code === "string")
      issues.push({ field, code });
  }
  return issues;
}

export async function requestJson<T>(
  fetchImpl: FetchLike,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
): Promise<RequestResult<T>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    return failure(null, "NETWORK_ERROR");
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return failure(response.status, "UNEXPECTED_RESPONSE");
  }
  if (response.ok) return { ok: true, data: parsed as T };

  const answer = typeof parsed === "object" && parsed !== null ? parsed : {};
  const { error, issues } = answer as { error?: unknown; issues?: unknown };
  if (typeof error !== "string")
    return failure(response.status, "UNEXPECTED_RESPONSE");
  return failure(
    response.status,
    error,
    readIssues(issues),
    readValues(answer),
  );
}
