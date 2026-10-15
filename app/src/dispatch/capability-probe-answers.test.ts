// SPDX-License-Identifier: Apache-2.0

// What the sender (#326) makes of the answers a Dispatcher gives while its capability probe is on its way, has
// failed or has been denied (#331): the Dispatcher answers a Dynamic job with 503 and `Retry-After` when no verdict
// is there yet or the probe gave none (a platform error: try again), and with 200 `not_capable` only for the
// container's own "no". The two must not be mistaken: `not_capable` stops the dispatch for ten minutes
// (`STOPPED_REVIVE_MS`), a 503 is retried on the back-off. The answers here are the ones
// `dispatcher/src/probe/probed-launcher.test.ts` shows the Dispatcher sends.
import { describe, expect, it } from "vitest";
import { decideOutcome, BACKOFF_SCHEDULE_MS } from "./outcome.ts";
import { sendDispatch, type DispatchFetch } from "./send.ts";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const request = { body: '{"version":1}', headers: {} };

function answered(
  response: Response,
): Promise<ReturnType<typeof decideOutcome>> {
  const fetch: DispatchFetch = () => Promise.resolve(response);
  return sendDispatch({
    url: "https://dispatcher.example.test/dispatch",
    request,
    fetch,
    timeoutMs: 8000,
    now: () => NOW,
  }).then((result) => decideOutcome(result, 0, NOW));
}

describe("the answers of a Dispatcher whose capability probe has not proven Dynamic yet", () => {
  // #331-R02
  it("retries a 503 with the probe's Retry-After on the back-off, and does not stop the dispatch", async () => {
    const update = await answered(
      new Response(JSON.stringify({ error: { code: "RUNNER_UNAVAILABLE" } }), {
        status: 503,
        headers: { "retry-after": "20" },
      }),
    );

    expect(update.state).toBe("pending");
    expect(update.lastCode).toBe("unavailable");
    expect(update.alert).toBe(false);
    // The back-off (10 s) and the header (20 s): the longer wins, so the probe is not asked again too soon.
    expect(update.nextDispatchAt.getTime() - NOW.getTime()).toBe(
      Math.max(BACKOFF_SCHEDULE_MS[0], 20_000),
    );
  });

  // #331-R02
  it("holds a failed probe's longer Retry-After (what is left of the failure time) against the back-off", async () => {
    const update = await answered(
      new Response(null, { status: 503, headers: { "retry-after": "60" } }),
    );

    expect(update.state).toBe("pending");
    expect(update.nextDispatchAt.getTime() - NOW.getTime()).toBe(60_000);
  });

  // #331-R02
  it("stops the dispatch for a denial, the container's own answer", async () => {
    const update = await answered(
      new Response(
        JSON.stringify({
          version: 1,
          status: "ignored",
          reason: "not_capable",
        }),
        { status: 200 },
      ),
    );

    expect(update.state).toBe("stopped");
    expect(update.lastCode).toBe("ignored_not_capable");
  });
});
