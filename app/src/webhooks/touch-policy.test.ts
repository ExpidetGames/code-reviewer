// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { WEBHOOK_ACCEPTED_OUTCOMES } from "./errors.ts";
import { deliveryTouchedTheQueue, TOUCHING_OUTCOMES } from "./touch-policy.ts";

const accepted = (outcome: string) =>
  Response.json({ status: "accepted", outcome }, { status: 202 });

describe("which answers of the webhook route start the repair work of the requests that touch the database", () => {
  // #395-T11
  it.each(WEBHOOK_ACCEPTED_OUTCOMES)(
    "decides for the outcome %s, and leaves the response readable",
    async (outcome) => {
      const response = accepted(outcome);

      const touched = await deliveryTouchedTheQueue(response);

      expect(touched).toBe(TOUCHING_OUTCOMES.includes(outcome));
      expect(await response.json()).toEqual({ status: "accepted", outcome });
    },
  );

  // #395-T11
  it("is never for a duplicate, an event the app does not use, or an ignored delivery", async () => {
    for (const outcome of ["duplicate", "event_not_used", "ignored"])
      expect(await deliveryTouchedTheQueue(accepted(outcome))).toBe(false);
  });

  // #395-T11
  it("is never for a refusal or an answer that is not the JSON of the route", async () => {
    expect(
      await deliveryTouchedTheQueue(
        Response.json({ outcome: "trigger_enqueued" }, { status: 401 }),
      ),
    ).toBe(false);
    expect(
      await deliveryTouchedTheQueue(new Response("no json", { status: 202 })),
    ).toBe(false);
  });
});
