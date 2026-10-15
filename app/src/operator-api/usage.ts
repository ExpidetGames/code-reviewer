// SPDX-License-Identifier: Apache-2.0

// The three usage routes of the operator API (#278), as functions of their collaborators like api.ts, which calls
// them after the credential, the route, the method, the body and the workspace have been checked:
//
//   GET /usage                          the settled records of every workspace, after a cursor
//   GET /workspaces/{id}/usage          the same for one workspace, with `from` and `to` on the time of settlement
//   GET /workspaces/{id}/usage/summary  what one workspace ran in a period, per review kind and key mode
//
// A record is served only once its settlement is older than the safety lag, so that a record that commits late
// cannot be behind a position a reader already holds. Readers still treat `id` as the idempotency key. Reads log
// nothing.
import type { UsageFeedRepository } from "../db/repositories/usage-feed-repository.ts";
import type {
  UsageCursor,
  UsageRecordsPage,
  UsageRecordsRepository,
} from "../db/repositories/usage-records-repository.ts";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, isTimestamp } from "./contract.ts";
import { errorResponse, jsonResponse } from "./responses.ts";
import { decodeUsageCursor, encodeUsageCursor } from "./usage-cursor.ts";
import { usageItemView, usageSummaryGroupView } from "./usage-views.ts";

export type UsageDeps = {
  feed: UsageFeedRepository;
  usageFor: (workspaceId: string) => UsageRecordsRepository;
  now: () => Date;
  safetyLagMs: number;
};

type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response };

/** `after` and `limit` of a page request. A cursor that is not ours is `cursor_invalid`, any other bad value `request_invalid`. */
function parsePage(
  url: URL,
): Parsed<{ after: UsageCursor | undefined; limit: number }> {
  const limitText = url.searchParams.get("limit");
  let limit = DEFAULT_PAGE_SIZE;
  if (limitText !== null) {
    if (!/^\d{1,4}$/.test(limitText))
      return { ok: false, response: errorResponse(400, "request_invalid") };
    limit = Number(limitText);
    if (limit < 1 || limit > MAX_PAGE_SIZE)
      return { ok: false, response: errorResponse(400, "request_invalid") };
  }
  const cursor = url.searchParams.get("after");
  if (cursor === null) return { ok: true, value: { after: undefined, limit } };
  const after = decodeUsageCursor(cursor);
  if (after === null)
    return { ok: false, response: errorResponse(400, "cursor_invalid") };
  return { ok: true, value: { after, limit } };
}

/** A time of the query: absent is fine where the caller allows it; present, it must be a real `Timestamp`. */
function parseTime(url: URL, name: "from" | "to"): string | null | "invalid" {
  const text = url.searchParams.get(name);
  if (text === null) return null;
  return isTimestamp(text) ? text : "invalid";
}

/** `from` and `to` as a period that is not empty. */
function parsePeriod(
  url: URL,
  required: boolean,
): Parsed<{ from?: string; to?: string }> {
  const invalid = {
    ok: false,
    response: errorResponse(400, "period_invalid"),
  } as const;
  const from = parseTime(url, "from");
  const to = parseTime(url, "to");
  if (from === "invalid" || to === "invalid") return invalid;
  if (required && (from === null || to === null)) return invalid;
  if (from !== null && to !== null && from >= to) return invalid;
  return {
    ok: true,
    value: {
      ...(from === null ? {} : { from }),
      ...(to === null ? {} : { to }),
    },
  };
}

export function createUsageHandlers(deps: UsageDeps) {
  /** Records settled before this are old enough to be served. */
  function settledBefore(): string {
    return new Date(deps.now().getTime() - deps.safetyLagMs).toISOString();
  }

  function pageAnswer(page: UsageRecordsPage): Response {
    return jsonResponse(200, {
      items: page.records.map(usageItemView),
      nextCursor: page.next === undefined ? null : encodeUsageCursor(page.next),
    });
  }

  return {
    /** `GET /usage`: every workspace. */
    async feed(request: Request): Promise<Response> {
      const page = parsePage(new URL(request.url));
      if (!page.ok) return page.response;
      return pageAnswer(
        await deps.feed.pageSettled({
          ...page.value,
          settledBefore: settledBefore(),
        }),
      );
    },

    /** `GET /workspaces/{id}/usage`: one workspace, the workspace known to exist. */
    async workspaceFeed(
      request: Request,
      workspaceId: string,
    ): Promise<Response> {
      const url = new URL(request.url);
      const page = parsePage(url);
      if (!page.ok) return page.response;
      const period = parsePeriod(url, false);
      if (!period.ok) return period.response;
      return pageAnswer(
        await deps.usageFor(workspaceId).pageSettled({
          ...page.value,
          ...period.value,
          settledBefore: settledBefore(),
        }),
      );
    },

    /** `GET /workspaces/{id}/usage/summary`: a period is required. */
    async summary(request: Request, workspaceId: string): Promise<Response> {
      const period = parsePeriod(new URL(request.url), true);
      if (!period.ok) return period.response;
      const { from, to } = period.value;
      if (from === undefined || to === undefined)
        return errorResponse(400, "period_invalid");
      const groups = await deps.usageFor(workspaceId).summarize({ from, to });
      return jsonResponse(200, {
        workspaceId,
        from,
        to,
        groups: groups.map(usageSummaryGroupView),
      });
    },
  };
}
