// SPDX-License-Identifier: Apache-2.0

"use client";
// The optional monthly spending limit (ADR 0006, 2.9; #499, #505): an Owner or an Admin types a limit in US dollars, an empty field
// removes it. It counts only what reviews were actually charged this UTC month; when that has reached the limit no new review
// starts until the next month or a higher limit, and a review that is running always finishes. The server judges the amount again.
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../components/button.tsx";
import { StatusRegion } from "../../components/status-region.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import { Field, FieldError, FieldLabel } from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import type { WorkspaceBillingApi } from "../api.ts";
import {
  describeBillingFailure,
  LIMIT_CLEARED_TEXT,
  LIMIT_EXPLAINER,
  LIMIT_HEADING,
  LIMIT_LABEL,
  LIMIT_SAVE_BUTTON,
  LIMIT_SAVED_TEXT,
} from "../messages.ts";
import { formatMoney, parseLimitCents } from "../money.ts";
import { useAction } from "./use-action.ts";

/** Whole cents as the text of the field: 25,000 is `250`, 25,050 is `250.50`. */
function textOfCents(cents: number | null): string {
  if (cents === null) return "";
  const whole = Math.floor(cents / 100);
  const fraction = cents % 100;
  return fraction === 0
    ? String(whole)
    : `${String(whole)}.${String(fraction).padStart(2, "0")}`;
}

export function MonthlyLimitCard({
  limitCents,
  chargedMicroUsd,
  api,
}: {
  limitCents: number | null;
  /** This UTC month's charges so far. */
  chargedMicroUsd: number | null;
  api: WorkspaceBillingApi;
}) {
  const id = useId();
  const { pending, outcome, run } = useAction();
  const [text, setText] = useState(() => textOfCents(limitCents));
  const [local, setLocal] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    const amount = parseLimitCents(text);
    if (!amount.ok) {
      setLocal(describeBillingFailure(amount.error));
      return;
    }
    setLocal(null);
    void run("save", async () => {
      const result = await api.setMonthlyLimit(amount.cents);
      if (!result.ok)
        return {
          kind: "failed",
          text: describeBillingFailure(result.code),
          issues: [],
        };
      return {
        kind: "ok",
        text: amount.cents === null ? LIMIT_CLEARED_TEXT : LIMIT_SAVED_TEXT,
      };
    });
  }

  const problem = local ?? (outcome?.kind === "failed" ? outcome.text : null);
  return (
    <Card role="region" aria-labelledby={id}>
      <CardHeader>
        <CardTitle>
          <h2 id={id} className="text-lg font-semibold tracking-tight">
            {LIMIT_HEADING}
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">{LIMIT_EXPLAINER}</p>
        {chargedMicroUsd === null ? null : (
          <p className="text-sm">
            Charged this month so far:{" "}
            <span className="font-semibold tabular-nums">
              {formatMoney(chargedMicroUsd)}
            </span>
          </p>
        )}
        <form
          onSubmit={submit}
          aria-label={LIMIT_HEADING}
          className="flex flex-wrap items-end gap-3"
        >
          <Field className="min-w-60 flex-1" data-invalid={problem !== null}>
            <FieldLabel htmlFor={`${id}-limit`}>{LIMIT_LABEL}</FieldLabel>
            <Input
              id={`${id}-limit`}
              inputMode="decimal"
              autoComplete="off"
              value={text}
              aria-invalid={problem !== null}
              onChange={(event) => {
                setText(event.target.value);
                setLocal(null);
              }}
            />
            {problem === null ? null : <FieldError>{problem}</FieldError>}
          </Field>
          <Button
            type="submit"
            variant="secondary"
            loading={pending === "save"}
            loadingLabel="Saving the limit"
          >
            {LIMIT_SAVE_BUTTON}
          </Button>
        </form>
        <StatusRegion>
          {outcome?.kind === "ok" ? (
            <Alert variant="success" role="note">
              <AlertDescription>{outcome.text}</AlertDescription>
            </Alert>
          ) : null}
        </StatusRegion>
      </CardContent>
    </Card>
  );
}
