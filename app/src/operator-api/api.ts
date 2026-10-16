// SPDX-License-Identifier: Apache-2.0

// The operator API as one function of its collaborators (`createOperatorApi`). The route files only call
// `withOperatorApi` (shared.ts); tests build the API with a real database. The order is the contract, and each
// step ends the request on failure:
//
//   0. off       no usable `OPERATOR_API_TOKEN`: the answer of a path that does not exist (Next's `notFound`)
//   1. token     `Authorization: Bearer <token>`, constant time compare                         401
//   2. route     a path the API does not have                                                   404 not_found
//   3. method    one the route does not offer                                                   405
//   4. body      GET and DELETE carry none                                                     400
//   5. workspace the id in the path names a workspace                                          404 workspace_not_found
//   6. work      PUT and POST: application/json, up to 16 KiB, one JSON value (415 / 413 / 400), then
//                read, replace or remove; usage: the query (400 request_invalid / cursor_invalid / period_invalid)
//                then the read (usage.ts)
//
// Nothing before step 1 reads the request body or touches the database. The API is separate from the browser
// session of `/api/admin/*`: no cookie is looked at.
import "server-only";
import type { PlanHandoffRedeemRepository } from "../db/repositories/plan-handoff-redeem-repository.ts";
import type { InstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import type {
  StoredEntitlements,
  WorkspaceEntitlementsRepository,
} from "../db/repositories/workspace-entitlements-repository.ts";
import type { UsageFeedRepository } from "../db/repositories/usage-feed-repository.ts";
import type { UsageRecordsRepository } from "../db/repositories/usage-records-repository.ts";
import type { WorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import {
  readPlanManagementUrl,
  savePlanManagementUrl,
} from "../plan-handoff/settings.ts";
import {
  hashHandoffToken,
  isWellFormedHandoffToken,
} from "../plan-handoff/token.ts";
import { describeError } from "../runner-api/logger.ts";
import { bearerTokenOf } from "../runner-api/token-auth.ts";
import { readLimitedBody } from "../webhooks/limited-body.ts";
import {
  resolveEntitlements,
  type EntitlementsData,
  type EntitlementsEntry,
} from "../workspaces/entitlements.ts";
import { EntitlementsError } from "../workspaces/entitlements-validation.ts";
import {
  DEFAULT_PAGE_SIZE,
  USAGE_SAFETY_LAG_MS,
  MAX_FIELD_LENGTH,
  MAX_PAGE_SIZE,
  OPERATOR_ID_PATTERN,
  OPERATOR_MAX_BODY_BYTES,
  ROUTE_METHODS,
  type OperatorRoute,
} from "./contract.ts";
import { errorResponse, jsonResponse, unauthorized } from "./responses.ts";
import { operatorTokensMatch } from "./token.ts";
import { createUsageHandlers } from "./usage.ts";
import { validateSafetyLagMs } from "./usage-cursor.ts";
import {
  changedFieldNames,
  defaultView,
  effectiveView,
  storedView,
} from "./views.ts";

export type OperatorApiLogger = {
  info(line: string): void;
  error(line: string): void;
};

export type OperatorApiDeps = {
  /** The configured token (read for every request); undefined while the API is off. */
  token: () => string | undefined;
  workspaces: WorkspacesRepository;
  entitlementsFor: (workspaceId: string) => WorkspaceEntitlementsRepository;
  settings: InstanceSettingsRepository;
  /** The settled usage records of every workspace (the feed). */
  usageFeed: UsageFeedRepository;
  /** The usage records of one workspace (its page and its summary). */
  usageFor: (workspaceId: string) => UsageRecordsRepository;
  /** The redemption of the handoff tokens of the "Manage plan" button (#284). */
  handoffs: PlanHandoffRedeemRepository;
  /** How old a settlement must be before it is served; default `USAGE_SAFETY_LAG_MS`. Validated when the API is made. */
  usageSafetyLagMs?: number;
  now: () => Date;
  logger: OperatorApiLogger;
  /** Ends the request with the answer of a path that does not exist (Next.js's `notFound`). */
  notFound: () => never;
};

export type OperatorApi = {
  handle(request: Request, route: OperatorRoute): Promise<Response>;
};

/** A refusal of the entitlements validation as an answer: 409 for a start that goes backwards, 422 otherwise. */
function refused(error: EntitlementsError): Response {
  const status = error.code === "period_start_backwards" ? 409 : 422;
  // An unknown key is client text: it is echoed only up to the length the contract allows for `field`.
  const field =
    error.field === undefined || error.field.length > MAX_FIELD_LENGTH
      ? undefined
      : error.field;
  return errorResponse(status, error.code, {
    ...(field === undefined ? {} : { field }),
  });
}

function isJsonContentType(header: string | null): boolean {
  if (header === null) return false;
  const type = header.split(";")[0]?.trim().toLowerCase();
  return type === "application/json";
}

function carriesBody(request: Request): boolean {
  const length = request.headers.get("content-length");
  if (length !== null && length.trim() !== "" && Number(length) !== 0)
    return true;
  return request.headers.has("transfer-encoding") || request.body !== null;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response };

function parsePage(url: URL): Parsed<{ after?: string; limit: number }> {
  const invalid = {
    ok: false,
    response: errorResponse(400, "request_invalid"),
  } as const;
  const limitText = url.searchParams.get("limit");
  let limit = DEFAULT_PAGE_SIZE;
  if (limitText !== null) {
    if (!/^\d{1,4}$/.test(limitText)) return invalid;
    limit = Number(limitText);
    if (limit < 1 || limit > MAX_PAGE_SIZE) return invalid;
  }
  const after = url.searchParams.get("after");
  if (after === null) return { ok: true, value: { limit } };
  if (!OPERATOR_ID_PATTERN.test(after)) return invalid;
  return { ok: true, value: { after, limit } };
}

export function createOperatorApi(deps: OperatorApiDeps): OperatorApi {
  const usage = createUsageHandlers({
    feed: deps.usageFeed,
    usageFor: deps.usageFor,
    now: deps.now,
    safetyLagMs: validateSafetyLagMs(
      deps.usageSafetyLagMs ?? USAGE_SAFETY_LAG_MS,
    ),
  });

  /** The log line of a write: names of changed fields and the result code, never a value. */
  function logWrite(
    action: "put" | "delete",
    target: string,
    fields: readonly string[],
    result: string,
  ): void {
    deps.logger.info(
      `[operator-api] ${action} workspace=${target} fields=${fields.length === 0 ? "-" : fields.join(",")} result=${result}`,
    );
  }

  /** The body of a PUT: a JSON value of the allowed size, or the answer that refuses it. */
  async function readJson(request: Request): Promise<Parsed<unknown>> {
    if (!isJsonContentType(request.headers.get("content-type")))
      return {
        ok: false,
        response: errorResponse(415, "unsupported_media_type"),
      };
    const body = await readLimitedBody(request, OPERATOR_MAX_BODY_BYTES);
    if (!body.ok)
      return { ok: false, response: errorResponse(413, "body_too_large") };
    try {
      return { ok: true, value: JSON.parse(body.text) as unknown };
    } catch {
      return { ok: false, response: errorResponse(400, "request_invalid") };
    }
  }

  /**
   * A body for the entitlements. A body without `periodStart` keeps the stored one (or starts now when there
   * is none to keep), so a partial change such as a suspension is not refused by a stale start.
   */
  function withPeriodStart(
    input: unknown,
    stored: EntitlementsEntry | undefined,
  ): unknown {
    if (typeof input !== "object" || input === null || Array.isArray(input))
      return input;
    if ("periodStart" in input) return input;
    const keep =
      stored !== undefined && !("invalid" in stored)
        ? stored.periodStart
        : deps.now().toISOString();
    return { ...input, periodStart: keep };
  }

  async function listWorkspaces(request: Request): Promise<Response> {
    const page = parsePage(new URL(request.url));
    if (!page.ok) return page.response;
    const { workspaces, hasMore } = await deps.workspaces.listPage(page.value);
    return jsonResponse(200, {
      workspaces: workspaces.map((workspace) => ({
        id: workspace.id,
        slug: workspace.slug,
        createdAt: workspace.createdAt,
      })),
      nextAfter: hasMore ? (workspaces.at(-1)?.id ?? null) : null,
    });
  }

  async function workspaceAnswer(
    workspaceId: string,
    stored: StoredEntitlements | undefined,
  ): Promise<Response> {
    const defaults = await deps.settings.getDefaultEntitlements();
    return jsonResponse(200, {
      workspaceId,
      stored: storedView(stored),
      effective: effectiveView(resolveEntitlements(stored, defaults)),
    });
  }

  async function workspaceEntitlements(
    request: Request,
    workspaceId: string,
  ): Promise<Response> {
    const repository = deps.entitlementsFor(workspaceId);
    if (request.method === "GET")
      return workspaceAnswer(workspaceId, await repository.get());

    if (request.method === "DELETE") {
      await repository.remove();
      logWrite("delete", workspaceId, [], "ok");
      return workspaceAnswer(workspaceId, undefined);
    }

    const body = await readJson(request);
    if (!body.ok) return body.response;
    const before = await repository.get();
    try {
      const stored = await repository.put(
        // Not yet checked: `put` validates, and refuses with an EntitlementsError.
        withPeriodStart(body.value, before) as EntitlementsData,
        null,
      );
      const fields =
        "invalid" in stored ? [] : changedFieldNames(before, stored);
      logWrite("put", workspaceId, fields, "ok");
      return workspaceAnswer(workspaceId, stored);
    } catch (error) {
      if (!(error instanceof EntitlementsError)) throw error;
      logWrite("put", workspaceId, [], error.code);
      return refused(error);
    }
  }

  async function defaultEntitlements(request: Request): Promise<Response> {
    if (request.method === "GET")
      return jsonResponse(200, {
        default: defaultView(await deps.settings.getDefaultEntitlements()),
      });

    const body = await readJson(request);
    if (!body.ok) return body.response;
    const before = await deps.settings.getDefaultEntitlements();
    try {
      await deps.settings.set(
        "default_entitlements",
        // Not yet checked: `set` validates, and refuses with an EntitlementsError.
        withPeriodStart(body.value, before) as EntitlementsData,
        null,
      );
    } catch (error) {
      if (!(error instanceof EntitlementsError)) throw error;
      logWrite("put", "default", [], error.code);
      return refused(error);
    }
    const stored = await deps.settings.getDefaultEntitlements();
    const fields =
      stored === undefined || "invalid" in stored
        ? []
        : changedFieldNames(before, stored);
    logWrite("put", "default", fields, "ok");
    return jsonResponse(200, { default: defaultView(stored) });
  }

  function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  /**
   * `POST /handoff/redeem` `{ token }`: who a handoff token was made for, once. Every reason for not answering is the
   * same `invalid_token`; the answer holds ids and a role only, and the log a workspace id and a result code.
   */
  async function redeemHandoff(request: Request): Promise<Response> {
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const value = body.value;
    if (
      !isObject(value) ||
      Object.keys(value).length !== 1 ||
      typeof value.token !== "string"
    )
      return errorResponse(400, "request_invalid");
    const redeemed = isWellFormedHandoffToken(value.token)
      ? await deps.handoffs.redeem(hashHandoffToken(value.token))
      : undefined;
    if (redeemed === undefined) {
      deps.logger.info(
        "[operator-api] handoff workspace=- result=invalid_token",
      );
      return errorResponse(422, "invalid_token");
    }
    deps.logger.info(
      `[operator-api] handoff workspace=${redeemed.workspaceId} result=ok`,
    );
    return jsonResponse(200, {
      workspaceId: redeemed.workspaceId,
      workspaceSlug: redeemed.workspaceSlug,
      userId: redeemed.userId,
      role: redeemed.role,
    });
  }

  async function planManagementAnswer(): Promise<Response> {
    return jsonResponse(200, {
      planManagementUrl: await readPlanManagementUrl(deps.settings),
    });
  }

  /** `GET|PUT|DELETE /plan-management`: the page "Manage plan" hands people over to (#284). */
  async function planManagement(request: Request): Promise<Response> {
    if (request.method === "GET") return planManagementAnswer();
    if (request.method === "DELETE") {
      await savePlanManagementUrl(deps.settings, null, null);
      deps.logger.info("[operator-api] delete plan-management result=ok");
      return planManagementAnswer();
    }
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const value = body.value;
    if (
      !isObject(value) ||
      Object.keys(value).length !== 1 ||
      !("url" in value)
    )
      return errorResponse(400, "request_invalid");
    // `null` would remove the page: that is what DELETE is for, so here it is just not a valid address.
    const saved = await savePlanManagementUrl(
      deps.settings,
      value.url === null ? "" : value.url,
      null,
    );
    if (!saved.ok) {
      deps.logger.info(
        `[operator-api] put plan-management result=${saved.code}`,
      );
      return errorResponse(422, saved.code);
    }
    deps.logger.info("[operator-api] put plan-management result=ok");
    return planManagementAnswer();
  }

  async function work(
    request: Request,
    route: OperatorRoute,
  ): Promise<Response> {
    switch (route.kind) {
      case "handoff-redeem":
        return redeemHandoff(request);
      case "plan-management":
        return planManagement(request);
      case "workspaces":
        return listWorkspaces(request);
      case "default-entitlements":
        return defaultEntitlements(request);
      case "usage":
        return usage.feed(request);
      case "workspace-entitlements":
      case "workspace-usage":
      case "workspace-usage-summary": {
        const id = route.workspaceId;
        const workspace = OPERATOR_ID_PATTERN.test(id)
          ? await deps.workspaces.get(id)
          : undefined;
        if (workspace === undefined)
          return errorResponse(404, "workspace_not_found");
        if (route.kind === "workspace-usage")
          return usage.workspaceFeed(request, workspace.id);
        if (route.kind === "workspace-usage-summary")
          return usage.summary(request, workspace.id);
        return workspaceEntitlements(request, workspace.id);
      }
      case "unknown":
        return errorResponse(404, "not_found");
    }
  }

  return {
    async handle(request, route) {
      const configured = deps.token();
      if (configured === undefined) return deps.notFound();
      try {
        const provided = bearerTokenOf(request.headers.get("authorization"));
        if (provided === null || !operatorTokensMatch(configured, provided))
          return unauthorized();
        if (route.kind === "unknown") return errorResponse(404, "not_found");
        const allowed = ROUTE_METHODS[route.kind];
        if (!allowed.includes(request.method))
          return errorResponse(405, "method_not_allowed", {
            headers: { Allow: allowed.join(", ") },
          });
        if (
          request.method !== "PUT" &&
          request.method !== "POST" &&
          carriesBody(request)
        )
          return errorResponse(400, "body_not_allowed");
        return await work(request, route);
      } catch (error) {
        deps.logger.error(
          `[operator-api] ${request.method} failed: ${describeError(error)}`,
        );
        return errorResponse(500, "internal_error");
      }
    },
  };
}
