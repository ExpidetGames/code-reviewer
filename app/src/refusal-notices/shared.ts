// SPDX-License-Identifier: Apache-2.0

// The notice of a refused review on the running server (#281): the service over the real database and registry,
// and the hook the runner queue calls for every job its claim refused. The post runs after the response of the claim
// (`after()` on a serverless platform, which keeps the function alive for it; src/dispatch/shared.ts), never in a
// timer, and never delays or changes the claim.
import "server-only";
import { getDatabase } from "../db/startup.ts";
import { runAfterResponse } from "../dispatch/shared.ts";
import { integrationRegistry } from "../integrations/registry.ts";
import { assembleRefusalNoticeService } from "./assemble.ts";
import type { NoticeRefusal, RefusalNoticeService } from "./service.ts";

let service: RefusalNoticeService | undefined;

/** One service per process: its queue keeps a backlog of refusals from opening many requests at GitHub at once. */
export function getRefusalNoticeService(): RefusalNoticeService {
  service ??= assembleRefusalNoticeService({
    db: getDatabase(),
    registry: integrationRegistry,
    // No instance has configured a plan page yet (#284 owns the setting and the page it hands over to): no link.
    planPageUrl: () => null,
    log: console,
  });
  return service;
}

/** What the runner queue calls for a refused job. Never throws. */
export function noticeOfRefusal(refusal: NoticeRefusal): void {
  runAfterResponse(() => getRefusalNoticeService().onRefused(refusal));
}
