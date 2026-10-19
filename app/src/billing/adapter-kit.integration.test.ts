// SPDX-License-Identifier: Apache-2.0

// #497-T14: the application half of the adapter test kit, for the fake adapter, on every engine. (The manual adapter has
// no webhook, so it has no events to apply; its credits are tested in manual-credit.integration.test.ts.)
import { BILLING_ENGINES } from "../test-support/billing-engines.ts";
import { describeAdapterApplication } from "../test-support/billing-adapter-kit.ts";
import {
  createFakeBillingAdapter,
  fakeWebhookRequest,
  type FakeWireEvent,
} from "../test-support/fake-billing-adapter.ts";

const NOW = new Date("2026-10-19T08:00:00.000Z");
let counter = 0;
const lookups = new Map<string, FakeWireEvent>();

describeAdapterApplication(
  {
    name: "fake",
    create: () =>
      createFakeBillingAdapter({
        lookups: (intentId) => lookups.get(intentId),
      }),
    now: NOW,
    fixtures: ({ intentId, amount }) => {
      counter += 1;
      const payment = `pi_kit_${counter}`;
      const created = NOW.toISOString();
      const wire = (id: string): FakeWireEvent => ({
        id: `${id}_${counter}`,
        kind: "payment",
        created,
        intent: intentId,
        payment,
        checkout: `cs_kit_${counter}`,
        net: amount,
        gross: amount + 4_000_000,
        tax: 4_000_000,
      });
      const paid = (id: string) => fakeWebhookRequest(wire(id));
      lookups.set(intentId, wire("evt_lookup"));
      const refundAmount = 5_000_000;
      return {
        paid: paid("evt_completed"),
        // Another delivery of the same payment under another event id.
        paidAgain: paid("evt_succeeded"),
        refunded: fakeWebhookRequest({
          id: `evt_refund_${counter}`,
          kind: "refund",
          created: new Date(NOW.getTime() + 60_000).toISOString(),
          payment,
          refund: `re_kit_${counter}`,
          // Net 25 of a gross 29: a share of 5 net is 5.8 of the gross.
          amount: 5_800_000,
          payment_amount: amount + 4_000_000,
          status: "approved",
        }),
        refundAmount,
      };
    },
  },
  BILLING_ENGINES,
);
