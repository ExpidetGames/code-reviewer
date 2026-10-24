// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/cron/reap-sandboxes: the platform's cron calls it (`vercel.json` "crons") and the reaper stops the Sandbox VMs
// that outlived their purpose (#364). `CRON_SECRET` of this project is the whole credential: the platform sends it as
// `Authorization: Bearer <secret>`. It is a secret of its own (config.ts refuses one that equals the dispatcher credential
// or a signing secret), so neither of those opens this route and this one opens nothing else. Without a secret every
// caller is refused. The answer carries counts and stable codes only.
import { createHash, timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import type { Logger } from "../core/types.ts";
import { ReapError, type Reaper } from "./reaper.ts";

export const REAP_PATH = "/api/cron/reap-sandboxes";

export const REAP_ROUTE_ERROR_CODES = [
  "CRON_UNAUTHORIZED",
  "REAP_LIST_FAILED",
  "REAP_FAILED",
] as const;
export type ReapRouteErrorCode = (typeof REAP_ROUTE_ERROR_CODES)[number];

export type ReaperRouteOptions = {
  /** `CRON_SECRET`; unset or empty refuses every caller. */
  cronSecret: string | undefined;
  reaper: Reaper;
  logger: Logger;
};

const HEADERS = { "cache-control": "no-store" } as const;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Constant time, and the same work whatever the lengths. A missing or empty secret matches nothing. */
function matches(secret: string | undefined, provided: string | null): boolean {
  if (secret === undefined || secret === "" || provided === null) return false;
  return timingSafeEqual(digest(secret), digest(provided));
}

function bearer(header: string | undefined): string | null {
  const match = /^Bearer (\S+)$/.exec(header ?? "");
  return match?.[1] ?? null;
}

export function mountReaperRoute(app: Hono, options: ReaperRouteOptions): void {
  app.get(REAP_PATH, async (c) => {
    if (!matches(options.cronSecret, bearer(c.req.header("authorization"))))
      return c.json(
        {
          error: {
            code: "CRON_UNAUTHORIZED" satisfies ReapRouteErrorCode,
            message: "A valid cron secret is required.",
          },
        },
        401,
        HEADERS,
      );
    try {
      const report = await options.reaper.run();
      return c.json({ status: "ok", ...report }, 200, HEADERS);
    } catch (error) {
      const code: ReapRouteErrorCode =
        error instanceof ReapError ? error.code : "REAP_FAILED";
      // The cause is not repeated: it may carry what a platform answered.
      if (code === "REAP_FAILED") options.logger.error("reap_failed");
      return c.json({ status: "error", code }, 500, HEADERS);
    }
  });
}
