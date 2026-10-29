// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /apps/check (#730): for each app the Dispatcher serves, asks that App's `GET /api/runners/v1/version` with that app's
// own dispatcher credential and reports whether the App is reachable, takes the credential and has the features of the
// split. It is the per-app canary of a deploy: a new Dispatcher that cannot reach an App, or whose credential for it is
// wrong, shows here before a job is lost. The caller needs the operator credential (`DISPATCHER_OPERATOR_TOKEN`), never an
// app's: the route sends every app's credential, each to its own URL of the registry, so it is not for an app to call.
// Without an operator token every caller is refused. The answer (`AppsCheckResponse`, contracts/dispatcher-ops.v1.json)
// holds ids, booleans and stable codes; no URL, no credential and no text the App sent.
import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { createAppClient, type AppFailure } from "../core/app-client.ts";
import type { AppSettings, Logger } from "../core/types.ts";

export const APPS_CHECK_PATH = "/apps/check";

export type AppCheck = {
  id: string;
  reachable: boolean;
  credentialAccepted: boolean | null;
  missingFeatures: string[];
  code: AppFailure | null;
};

export type AppsCheckRouteOptions = {
  /** `DISPATCHER_OPERATOR_TOKEN`; absent refuses every caller. */
  token: string | undefined;
  apps: readonly AppSettings[];
  logger: Logger;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
};

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function authorized(header: string | undefined, token: string | undefined) {
  const match = /^Bearer ([^\s]+)$/.exec(header ?? "");
  if (match?.[1] === undefined || token === undefined) return false;
  return timingSafeEqual(digest(match[1]), digest(token));
}

function refuse(c: Context): Response {
  return c.json(
    {
      error: {
        code: "RUNNER_UNAUTHORIZED",
        message: "The request could not be verified.",
      },
    },
    401,
  );
}

/** One app: the version call with its credential, reduced to the fields of `AppCheck`. */
export async function checkApp(
  app: AppSettings,
  options: { fetch: typeof fetch; requestTimeoutMs?: number },
): Promise<AppCheck> {
  const client = createAppClient({
    appUrl: app.url,
    token: app.token,
    poolId: app.poolId,
    fetch: options.fetch,
    requestTimeoutMs: options.requestTimeoutMs,
  });
  const checked = await client.checkVersion();
  if (checked.ok)
    return {
      id: app.id,
      reachable: true,
      credentialAccepted: true,
      missingFeatures: [],
      code: null,
    };
  return {
    id: app.id,
    reachable: checked.code !== "app_unreachable",
    credentialAccepted:
      checked.code === "app_rejected"
        ? false
        : checked.code === "app_unreachable" || checked.code === "app_error"
          ? null
          : checked.code === "app_too_old" &&
              checked.missingFeatures === undefined
            ? null
            : true,
    missingFeatures: checked.missingFeatures ?? [],
    code: checked.code,
  };
}

export function mountAppsCheckRoute(
  app: Hono,
  options: AppsCheckRouteOptions,
): void {
  const { logger } = options;
  app.post(APPS_CHECK_PATH, async (c) => {
    if (!authorized(c.req.header("authorization"), options.token)) {
      logger.warn("apps_check_refused");
      return refuse(c);
    }
    const apps = await Promise.all(
      options.apps.map((configured) =>
        checkApp(configured, {
          fetch: options.fetch ?? fetch,
          requestTimeoutMs: options.requestTimeoutMs,
        }),
      ),
    );
    const ok = apps.every((result) => result.code === null);
    logger.info("apps_checked", {
      ok,
      apps: apps.map((result) => ({ id: result.id, code: result.code })),
    });
    c.header("cache-control", "no-store");
    return c.json({ version: 1, ok, apps }, 200);
  });
}
