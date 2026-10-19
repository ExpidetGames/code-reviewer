// SPDX-License-Identifier: Apache-2.0

// #497-T14: the application half of the adapter test kit, for the fake adapter, on every engine. (The manual adapter has
// no webhook, so it has no events to apply; its credits are tested in manual-credit.integration.test.ts.)
import { BILLING_ENGINES } from "../test-support/billing-engines.ts";
import { describeAdapterApplication } from "../test-support/billing-adapter-kit.ts";
import {
  createFakeBillingAdapter,
  fakeWebhookRequest,
} from "../test-support/fake-billing-adapter.ts";

const NOW = new Date("2026-10-19T08:00:00.000Z");
let counter = 0;

describeAdapterApplication(
  {
    name: "fake",
    create: () => createFakeBillingAdapter(),
    now: NOW,
    fixtures: ({ intentId, amount }) => {
      counter += 1;
      const payment = `pi_kit_${counter}`;
      const created = NOW.toISOString();
      const paid = (id: string) =>
        fakeWebhookRequest({
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
          amount: refundAmount,
          status: "approved",
        }),
        refundAmount,
      };
    },
  },
  BILLING_ENGINES,
);
