// SPDX-License-Identifier: Apache-2.0

"use client";
// Creating the Paddle prices of the current version (#440, ADR 0005, 2.11): the operator presses a button and the app makes the
// Paddle product on first use and a new price for each amount entered for the version. The one choice is the trial, in days.
// There is no field for an amount, a currency, an interval or a tax mode: they are the version's, and the server takes
// nothing of them from the request. Below the button: the attempts no version is sold with (a failed one is retried by the
// button, a created price that could not be linked can be archived). Everything Paddle said stays on the server; the page
// shows the copy of a stable code.
import { useState, type FormEvent } from "react";
import { Button } from "../../components/button.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import type { RequestResult } from "../../ui/json-request.ts";
import type { PlansApi, PlansWriteAnswer } from "./plans-api.ts";
import { describePrice } from "./plans-format.ts";
import { describePlanFailure } from "./plans-messages.ts";
import type {
  PlanVersionView,
  PlanView,
  PriceAttemptView,
} from "./plans-view.ts";

/** The longest trial the server takes (`MAX_TRIAL_DAYS` in src/billing/price-create-rules.ts, server code). */
const MAX_TRIAL_DAYS = 365;
const WHOLE_DAYS = /^[0-9]{1,4}$/;

const SLOT_WORDS = { month: "Monthly", year: "Yearly" } as Record<
  string,
  string
>;

/** Codes after which nothing was made, so there is nothing to reload for. */
const NOTHING_MADE = new Set([
  "price_trial_invalid",
  "price_input_invalid",
  "price_amount_invalid",
  "plan_not_found",
  "plan_archived",
  "price_plan_not_paid",
  "api_key_missing",
  "api_key_unreadable",
]);

function amountText(amount: string): string {
  const minor = Number(amount);
  return Number.isSafeInteger(minor) ? describePrice(minor) : amount;
}

function Attempt({
  attempt,
  pending,
  onArchive,
}: {
  attempt: PriceAttemptView;
  pending: boolean;
  onArchive: (paddlePriceId: string) => void;
}) {
  const slot = `${SLOT_WORDS[attempt.interval] ?? attempt.interval} price ${amountText(attempt.amount)}`;
  if (attempt.state === "ready" && attempt.paddlePriceId !== null) {
    const id = attempt.paddlePriceId;
    return (
      <li className="flex flex-wrap items-center gap-3 text-sm">
        <span>
          {slot}: <span className="font-mono">{id}</span> was created at Paddle
          but no version is sold with it.
        </span>
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          aria-label={`Archive price ${id}`}
          onClick={() => onArchive(id)}
        >
          Archive
        </Button>
      </li>
    );
  }
  if (attempt.state === "pending")
    return (
      <li className="text-sm">
        {slot}: being created. If nothing happens, the attempt was interrupted;
        Create prices takes it over after ten minutes.
      </li>
    );
  return (
    <li className="text-sm">
      {slot}: not created.{" "}
      {describePlanFailure(attempt.errorCode ?? "unavailable")} Press Create
      prices to try again.
    </li>
  );
}

export function PlanPriceCreate({
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
  const [trial, setTrial] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const missing: Array<{ interval: "month" | "year"; entered: number }> = [];
  if (version.monthlyAmountMinor !== null && version.monthlyPrice === null)
    missing.push({ interval: "month", entered: version.monthlyAmountMinor });
  if (version.yearlyAmountMinor !== null && version.yearlyPrice === null)
    missing.push({ interval: "year", entered: version.yearlyAmountMinor });
  if (missing.length === 0 && plan.priceAttempts.length === 0) return null;

  async function send(
    request: Promise<RequestResult<PlansWriteAnswer>>,
    message: string,
  ) {
    setPending(true);
    setFailure(null);
    const result = await request;
    setPending(false);
    if (!result.ok) {
      const slot = result.issues
        .map((issue) => SLOT_WORDS[issue.field])
        .find((word) => word !== undefined);
      const reason = describePlanFailure(result.code);
      setFailure(
        `${slot === undefined ? "" : `${slot} price: `}${reason}${
          NOTHING_MADE.has(result.code)
            ? ""
            : " What was made is kept. Reload the page to see what was made."
        }`,
      );
      return;
    }
    onDone(result.data, message);
  }

  function create(event: FormEvent) {
    event.preventDefault();
    const text = trial.trim();
    let trialDays: number | undefined;
    if (text !== "") {
      trialDays = WHOLE_DAYS.test(text) ? Number(text) : Number.NaN;
      if (
        !Number.isSafeInteger(trialDays) ||
        trialDays < 1 ||
        trialDays > MAX_TRIAL_DAYS
      ) {
        setFailure(describePlanFailure("price_trial_invalid"));
        return;
      }
    }
    void send(
      api.change(plan.planKey, {
        createPrices: {
          versionNumber: version.number,
          ...(trialDays === undefined ? {} : { trialDays }),
        },
      }),
      `Paddle prices of ${plan.name} created and linked.`,
    );
  }

  return (
    <form
      aria-label={`Create Paddle prices of ${plan.name}`}
      onSubmit={create}
      className="flex flex-col gap-4"
    >
      <h4 className="font-medium">Create the Paddle prices</h4>
      {missing.length === 0 ? null : (
        <>
          <p className="text-sm text-muted-foreground">
            The app creates the Paddle product, if the plan has none, and a new
            price for{" "}
            {missing
              .map(
                ({ interval, entered }) =>
                  `${describePrice(entered)} per ${interval}`,
              )
              .join(" and ")}
            , the amounts entered for this version, in US dollars, tax included.
            It never changes a price at Paddle: a changed amount is a new
            version with new prices.
          </p>
          <Field>
            <FieldLabel htmlFor={`trial-${plan.planKey}`}>
              Trial days (optional)
            </FieldLabel>
            <Input
              id={`trial-${plan.planKey}`}
              aria-label="Trial days"
              value={trial}
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTrial(event.target.value)}
            />
            <FieldDescription>
              Leave empty for no trial. Whole days, 1 to {MAX_TRIAL_DAYS}.
            </FieldDescription>
          </Field>
        </>
      )}
      {failure === null ? null : (
        <Alert variant="destructive" role="note">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
      {plan.priceAttempts.length === 0 ? null : (
        <ul className="flex flex-col gap-2">
          {plan.priceAttempts.map((attempt) => (
            <Attempt
              key={`${attempt.interval}-${attempt.amount}-${attempt.paddlePriceId ?? attempt.attemptedAt ?? ""}`}
              attempt={attempt}
              pending={pending}
              onArchive={(paddlePriceId) =>
                void send(
                  api.change(plan.planKey, { archivePrice: { paddlePriceId } }),
                  "Price archived at Paddle.",
                )
              }
            />
          ))}
        </ul>
      )}
      {missing.length === 0 ? null : (
        <div>
          <Button type="submit" variant="secondary" disabled={pending}>
            Create prices
          </Button>
        </div>
      )}
    </form>
  );
}
