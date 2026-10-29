// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /stop (#487): the signed call by which the App tells the Dispatcher that a job's claim has ended, so that the
// Dispatcher stops that job's Sandbox VM. The Dispatcher does not supervise a Worker after the hand-over, and the VM
// never gets access to the Dispatcher; this is the whole of the way a VM is ended on purpose.
//
// It is verified exactly like `POST /dispatch` (verified-request.ts): content type and size, the form of the headers, the
// clock, the current and the previous key, the signature in constant time, then the closed body (`DispatchStop` of
// contracts/dispatch-webhook.v1.json) whose `stopId` must be the `x-dispatch-id` header. A refusal never says which check
// failed. Then, in this order:
//   - a stop id that was handled is answered 200 `replayed` and nothing is done;
//   - the VMs of the job are looked up (`findJobVms`): none is 200 `no_vm`, a platform that cannot be asked is 503 with
//     `Retry-After` and the id is forgotten, so the same call can be repeated;
//   - the stops go to the platform's background work (`waitUntil`) and the answer is 202 at once, naming the VMs (`vms`,
//     #493): stopping a VM with a running container takes 20 seconds or more. A stop that fails is logged with a stable
//     code and left to the reaper.
import type { Hono } from "hono";
import type { Logger } from "../core/types.ts";
import type { SandboxFleet } from "../launchers/sandbox-service.ts";
import { StopLookupError, findJobVms } from "../stop/job-stopper.ts";
import { createReplayGuard, type ReplayGuard } from "../stop/replay-guard.ts";
import { DispatchStopSchema } from "./stop-schema.ts";
import {
  refuse,
  verifyRequest,
  type VerifiedRequestOptions,
} from "./verified-request.ts";

export const STOP_PATH = "/stop";
const RETRY_AFTER_SECONDS = 5;

export type StopRouteOptions = VerifiedRequestOptions & {
  fleet: Pick<SandboxFleet, "list" | "stop">;
  logger: Logger;
  /** `waitUntil` on the platform, the tracker of the Node entry. */
  background: (work: Promise<unknown>) => void;
  replay?: ReplayGuard;
};

export function mountStopRoute(app: Hono, options: StopRouteOptions): void {
  const { fleet, logger } = options;
  const replay = options.replay ?? createReplayGuard();

  async function stopAll(jobId: string, names: readonly string[]) {
    await Promise.all(
      names.map(async (name) => {
        try {
          await fleet.stop(name);
          logger.info("vm_stopped", { jobId, sandbox: name });
        } catch {
          // Only that it failed: the platform's text is not ours to log. The reaper and the VM's timeout end it.
          logger.warn("vm_stop_failed", { jobId, sandbox: name });
        }
      }),
    );
  }

  app.post(STOP_PATH, async (c) => {
    const verified = await verifyRequest(c, {
      ...options,
      logger,
      refusedEvent: "stop_refused",
    });
    if (!verified.ok) return verified.response;

    let parsed: unknown;
    try {
      parsed = JSON.parse(verified.text);
    } catch {
      return refuse(c, "invalid");
    }
    const stop = DispatchStopSchema.safeParse(parsed);
    if (!stop.success || stop.data.stopId !== verified.id) {
      logger.warn("stop_refused", { verdict: "body_invalid" });
      return refuse(c, "invalid");
    }
    const { jobId, stopId } = stop.data;
    // The app is the one whose key verified the call. Its stop ids are its own: another app cannot use one up.
    const appId = verified.appId;
    const replayKey = `${appId}:${stopId}`;

    if (!replay.begin(replayKey)) {
      logger.info("stop_replayed", { app: appId, jobId });
      return c.json({ version: 1, status: "ignored", reason: "replayed" });
    }
    let names: string[];
    try {
      names = await findJobVms(fleet, jobId, appId);
    } catch (error) {
      replay.forget(replayKey);
      logger.error("stop_list_failed", {
        app: appId,
        jobId,
        code: error instanceof StopLookupError ? error.code : "STOP_FAILED",
      });
      return c.body(null, 503, {
        "retry-after": String(RETRY_AFTER_SECONDS),
      });
    }
    logger.info("stop_received", { app: appId, jobId, vms: names.length });
    if (names.length === 0)
      return c.json({ version: 1, status: "ignored", reason: "no_vm" });
    options.background(stopAll(jobId, names));
    // #493: the names let the App take its own clock at this answer as the end of each VM's billable minutes.
    return c.json(
      { version: 1, status: "stopping", vms: [...names].sort() },
      202,
    );
  });
}
