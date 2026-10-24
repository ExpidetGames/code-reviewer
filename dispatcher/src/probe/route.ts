// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /probe (#331): forces the capability probe and answers its report (`ProbeReport`,
// contracts/probe-verdict.v1.json). For a deploy step that must block a release whose Dynamic canary fails: 200
// when every engine this deployment is configured to serve is advertised, 503 with the same body when one is not.
// The caller needs the dispatcher credential (`Authorization: Bearer <RUNNER_TOKEN>`, checked before anything is
// started: a refused call creates no VM) and every refusal looks the same. The report holds engines, stable
// reasons and a stable code; no text of the container, the platform or an error.
import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import type { Engine, Launcher, Logger, ProbeResult } from "../core/types.ts";

export type ProbeRouteOptions = {
  /** The dispatcher credential (RUNNER_TOKEN). */
  token: string;
  /** The engines this deployment is configured to serve; the report is `ok` when the Launcher advertises all of them. */
  engines: readonly Engine[];
  launcher: Launcher;
  logger: Logger;
  /**
   * The Worker image id this deployment is configured with (`SANDBOX_IMAGE_DIGEST`): named in the report so that a
   * deploy step can tell which image its canary proved. Dropped unless it has the shape of an image id.
   */
  imageDigest?: string;
  /** The golden snapshot this deployment creates job VMs from (`SANDBOX_SNAPSHOT_ID`): named for the same reason. */
  snapshotId?: string;
  /** ISO time for a report the route makes itself. */
  now?: () => Date;
};

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const SNAPSHOT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,127}$/;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** True when the header is `Bearer <token>` for exactly this token; compares digests in constant time. */
function authorized(header: string | undefined, token: string): boolean {
  const match = /^Bearer ([^\s]+)$/.exec(header ?? "");
  if (match?.[1] === undefined) return false;
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

export function mountProbeRoute(app: Hono, options: ProbeRouteOptions): void {
  const { launcher, logger } = options;
  const now = options.now ?? (() => new Date());

  async function advertised(): Promise<Engine[]> {
    try {
      return [...(await launcher.capabilities(new AbortController().signal))];
    } catch {
      return [];
    }
  }

  async function run(): Promise<ProbeResult> {
    const checkedAt = now().toISOString();
    if (launcher.probe === undefined)
      // A Launcher without a probe proves nothing: what it advertises is its own word.
      return {
        status: "failed",
        engines: await advertised(),
        reasons: [],
        failure: "probe_not_supported",
        checkedAt,
      };
    try {
      return await launcher.probe(new AbortController().signal);
    } catch {
      logger.error("probe_route_failed");
      return {
        status: "failed",
        engines: ["pr-agent"],
        reasons: [],
        failure: "probe_error",
        checkedAt,
      };
    }
  }

  app.post("/probe", async (c) => {
    if (!authorized(c.req.header("authorization"), options.token)) {
      logger.warn("probe_refused");
      return refuse(c);
    }
    const result = await run();
    const ok = options.engines.every((engine) =>
      result.engines.includes(engine),
    );
    logger.info("probe_requested", { status: result.status, ok });
    c.header("cache-control", "no-store");
    const imageDigest = IMAGE_ID.test(options.imageDigest ?? "")
      ? { imageDigest: options.imageDigest }
      : {};
    const snapshotId = SNAPSHOT_ID.test(options.snapshotId ?? "")
      ? { snapshotId: options.snapshotId }
      : {};
    return c.json(
      { version: 1, ok, ...result, ...imageDigest, ...snapshotId },
      ok ? 200 : 503,
    );
  });
}
