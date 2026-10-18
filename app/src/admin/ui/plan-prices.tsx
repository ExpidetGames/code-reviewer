// SPDX-License-Identifier: Apache-2.0

"use client";
// The Paddle prices of the current version of a paid plan (#439, ADR 0005, 2.11): the operator makes the product and the
// prices in Paddle and pastes the price ids here. Next to the amount entered for the version the page shows what Paddle
// said, read-only, and whether the version can be sold. There is no field for an amount, a currency or a tax mode: they are
// the version's and Paddle's, and the app never writes a price to Paddle. The server judges every link.
import { useState, type FormEvent } from "react";
import { Button } from "../../components/button.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import { formatUtc } from "../../ui/format-time.ts";
import type { RequestResult } from "../../ui/json-request.ts";
import type { PlansApi, PlansWriteAnswer } from "./plans-api.ts";
import { describePaddleAmount, describePrice } from "./plans-format.ts";
import {
  describePlanFailure,
  describePriceDifference,
} from "./plans-messages.ts";
import type { PlanVersionView, PlanView, PriceLinkView } from "./plans-view.ts";

type Slot = "month" | "year";

const SLOT_WORDS = {
  month: { name: "Monthly", lower: "monthly", cycle: "month" },
  year: { name: "Yearly", lower: "yearly", cycle: "year" },
} as const;

const DRIFT_WORDS: Record<string, string> = {
  price_not_active: "the price is archived at Paddle.",
  price_not_recurring: "the price is not a subscription price any more.",
  price_has_overrides: "the price has country specific prices now.",
  price_product_mismatch: "the price belongs to another product.",
  price_environment_mismatch:
    "the price is from the other Paddle environment than the one billing is set to.",
};

function driftSentence(price: PriceLinkView): string {
  const drift = price.drift ?? "";
  const known = Object.hasOwn(DRIFT_WORDS, drift)
    ? DRIFT_WORDS[drift]
    : undefined;
  return (
    known ??
    describePriceDifference(drift, {
      ...(price.driftEntered === undefined
        ? {}
        : { entered: price.driftEntered }),
      ...(price.driftPaddle === undefined ? {} : { paddle: price.driftPaddle }),
    })
  );
}

function CachedPrice({ price }: { price: PriceLinkView }) {
  const trial =
    price.trialDays === null
      ? "no trial"
      : `a trial of ${price.trialDays} days`;
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p>
        <span className="font-mono">{price.paddlePriceId}</span>
      </p>
      <p>
        Paddle: {describePaddleAmount(price.amount)} {price.currency} every{" "}
        {price.interval},{" "}
        {price.taxMode === "internal"
          ? "tax included"
          : `tax mode ${price.taxMode}`}
        ; {price.status}; {trial}.
      </p>
      <p className="text-muted-foreground">
        Read from Paddle
        {price.snapshotAt === null
          ? "."
          : ` at ${formatUtc(price.snapshotAt)}.`}
      </p>
      {price.drift === null ? null : (
        <p>
          <Badge variant="warning">Drift</Badge>{" "}
          <span>Differs from this version: {driftSentence(price)}</span>
        </p>
      )}
    </div>
  );
}

export function PlanPrices({
  plan,
  version,
  api,
  onDone,
}: {
  plan: PlanView;
  version: PlanVersionView;
  api: PlansApi;
  onDone: (answer: PlansWriteAnswer, message: string) => void;
}) {
  const [ids, setIds] = useState<Record<Slot, string>>({ month: "", year: "" });
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function send(
    request: Promise<RequestResult<PlansWriteAnswer>>,
    message: string,
    after?: () => void,
  ) {
    setPending(true);
    setFailure(null);
    const result = await request;
    setPending(false);
    if (!result.ok) {
      // A refresh that could not read some prices names each one (its id is the field of the issue).
      const unread = result.issues.filter((issue) =>
        issue.field.startsWith("pri_"),
      );
      setFailure(
        unread.length === 0
          ? describePriceDifference(result.code, result.values ?? {})
          : `${unread
              .map(
                (issue) => `${issue.field}: ${describePlanFailure(issue.code)}`,
              )
              .join(
                " ",
              )} The other prices were read again. Reload the page to see them.`,
      );
      return;
    }
    after?.();
    onDone(result.data, message);
  }

  function link(slot: Slot, event: FormEvent) {
    event.preventDefault();
    const paddlePriceId = ids[slot].trim();
    if (paddlePriceId === "") {
      setFailure(describePlanFailure("price_id_invalid"));
      return;
    }
    void send(
      api.change(plan.planKey, {
        priceLink: {
          versionNumber: version.number,
          interval: slot,
          paddlePriceId,
        },
      }),
      `${SLOT_WORDS[slot].name} price of ${plan.name} linked.`,
      () => setIds((previous) => ({ ...previous, [slot]: "" })),
    );
  }

  const linked = version.monthlyPrice !== null || version.yearlyPrice !== null;
  const slots: Array<{
    slot: Slot;
    entered: number | null;
    price: PriceLinkView | null;
  }> = [
    {
      slot: "month",
      entered: version.monthlyAmountMinor,
      price: version.monthlyPrice,
    },
    {
      slot: "year",
      entered: version.yearlyAmountMinor,
      price: version.yearlyPrice,
    },
  ];

  return (
    <form
      aria-label={`Paddle prices of ${plan.name}`}
      onSubmit={(event) => event.preventDefault()}
      className="flex flex-col gap-4"
    >
      <h4 className="font-medium">Paddle prices</h4>
      <p className="text-sm text-muted-foreground">
        Create the product and the prices in Paddle, then paste the price IDs
        here. A price must be in US dollars, tax inclusive (tax mode internal),
        renew every month or every year like its slot, and carry exactly the
        amount entered for this version. The app only reads from Paddle: it
        never changes a price at Paddle, and a change of an amount is a new
        version with new prices.
      </p>
      {failure === null ? null : (
        <Alert variant="destructive" role="note">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
      {slots.map(({ slot, entered, price }) => {
        const words = SLOT_WORDS[slot];
        if (entered === null)
          return slot === "year" ? (
            <p key={slot} className="text-sm text-muted-foreground">
              No yearly price is entered for this version, so there is no yearly
              option and no yearly price to link.
            </p>
          ) : null;
        return (
          <FieldSet key={slot}>
            <FieldLegend variant="label">{words.name} price</FieldLegend>
            <p className="text-sm">
              Entered for this version: {describePrice(entered)} per{" "}
              {words.cycle}
            </p>
            {price === null ? null : <CachedPrice price={price} />}
            <Field>
              <FieldLabel htmlFor={`prices-${plan.planKey}-${slot}`}>
                {price === null
                  ? `${words.name} Paddle price ID`
                  : `Link another ${words.lower} price`}
              </FieldLabel>
              <Input
                id={`prices-${plan.planKey}-${slot}`}
                aria-label={`${words.name} Paddle price ID`}
                value={ids[slot]}
                placeholder="pri_..."
                autoComplete="off"
                spellCheck={false}
                onChange={(event) =>
                  setIds((previous) => ({
                    ...previous,
                    [slot]: event.target.value,
                  }))
                }
              />
              <FieldDescription>
                Linking checks the price at Paddle and stores what Paddle says.
              </FieldDescription>
            </Field>
            <div>
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={(event) => link(slot, event)}
              >
                Link {words.lower} price
              </Button>
            </div>
          </FieldSet>
        );
      })}
      <p className="text-sm">
        {version.sellable ? (
          <>
            <Badge variant="success">Ready to sell</Badge> Every price carries
            the amount entered for this version.
          </>
        ) : (
          <>
            <Badge variant="neutral">Not for sale yet</Badge> Every price this
            version has an amount for must be linked and carry exactly that
            amount.
          </>
        )}
      </p>
      {linked ? (
        <div>
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() =>
              void send(
                api.change(plan.planKey, { refreshPrices: true }),
                `The prices of ${plan.name} were read again from Paddle.`,
              )
            }
          >
            Refresh from Paddle
          </Button>
        </div>
      ) : null}
    </form>
  );
}
