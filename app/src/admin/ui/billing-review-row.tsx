// SPDX-License-Identifier: Apache-2.0

"use client";
// One billing review row (#603): what the application stored about an event it did not apply, in words an operator can act on,
// and the ways to deal with it: close it with a note (no money moves), credit or correct the workspace of the row by hand and
// close it in one step (the manual credit, once per row), or ask Stripe about the payment again ("Check payment"). The server
// judges every value and picks the workspace; the row shows the reason it gets back.
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../components/button.tsx";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { formatUtc } from "../../ui/format-time.ts";
import {
  describeBillingFailure,
  describeBillingIssue,
} from "./billing-messages.ts";
import { formatUsdFixed, parseUsd } from "./billing-money.ts";
import type { BillingReviewApi } from "./billing-review-api.ts";
import { describeOutcome, describeSubject } from "./billing-review-copy.ts";
import type { BillingReviewView } from "./billing-review-view.ts";
import { OutcomeNote, useBillingRun } from "./billing-run.tsx";

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

export function BillingReviewRow({
  review,
  api,
}: {
  review: BillingReviewView;
  api: BillingReviewApi;
}) {
  const ids = useId();
  const run = useBillingRun();
  const outcome = describeOutcome(review.outcome);
  const { suggestion } = review;
  const [note, setNote] = useState("");
  const [amount, setAmount] = useState(
    suggestion?.amountMicroUsd == null
      ? ""
      : formatUsdFixed(suggestion.amountMicroUsd),
  );
  const [localAmount, setLocalAmount] = useState<string | undefined>();

  const issueOf = (field: string) =>
    run.outcome?.kind === "failed"
      ? run.outcome.issues.find((issue) => issue.field === field)
      : undefined;
  const noteIssue = issueOf("note");
  const amountIssue = issueOf("amountMicroUsd");
  const target = { provider: review.provider, eventId: review.eventId };

  function close(event: FormEvent) {
    event.preventDefault();
    setLocalAmount(undefined);
    void run.run("close", async () => {
      const result = await api.resolve({ ...target, note });
      if (!result.ok)
        return {
          kind: "failed",
          text: describeBillingFailure(result.code),
          issues: result.issues,
          missing: [],
        };
      return { kind: "ok", text: "The row is closed. No money moved." };
    });
  }

  function creditAndClose() {
    if (suggestion === null) return;
    const micro = parseUsd(amount, {
      signed: suggestion.type === "correction",
    });
    if (micro === null) {
      setLocalAmount(
        describeBillingIssue({
          field: "amountMicroUsd",
          code: "amount_invalid",
        }),
      );
      return;
    }
    setLocalAmount(undefined);
    void run.run("credit", async () => {
      const result = await api.resolve({
        ...target,
        note,
        credit: { type: suggestion.type, amountMicroUsd: micro },
      });
      if (!result.ok)
        return {
          kind: "failed",
          text: describeBillingFailure(result.code),
          issues: result.issues,
          missing: [],
        };
      return {
        kind: "ok",
        text:
          suggestion.type === "credit"
            ? "The workspace is credited and the row is closed."
            : "The balance is corrected and the row is closed.",
      };
    });
  }

  function checkPayment() {
    void run.run("check", async () => {
      const result = await api.check(target);
      if (!result.ok)
        return {
          kind: "failed",
          text: describeBillingFailure(result.code),
          issues: result.issues,
          missing: [],
        };
      return {
        kind: "ok",
        text: `Stripe says the top-up is ${result.data.intentState}. Whatever it told was applied like a webhook; look at the workspace's balance, then close this row with a note.`,
      };
    });
  }

  return (
    <li
      aria-label={`Review ${review.eventId}`}
      className="flex flex-col gap-3 rounded-lg border border-border p-4"
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold">{outcome.title}</h3>
        <p className="text-sm text-muted-foreground">{outcome.reading}</p>
      </div>

      <dl className="flex flex-col gap-1 text-sm">
        <Fact label="Event">
          <code>{review.eventId}</code>
        </Fact>
        {review.subject === null ? null : (
          <Fact label="Stripe object">{describeSubject(review.subject)}</Fact>
        )}
        <Fact label="Workspace">
          {review.workspace === null ? (
            "No workspace of this instance is known for this event."
          ) : (
            <>
              {review.workspace.name}{" "}
              <span className="text-muted-foreground">
                ({review.workspace.slug})
              </span>
            </>
          )}
        </Fact>
        {review.intent === null ? null : (
          <>
            <Fact label="Top-up">
              <code>{review.intent.id}</code>, {review.intent.state},{" "}
              {formatUsdFixed(review.intent.amountMicroUsd)} USD asked
            </Fact>
            {review.intent.checkoutRef === null ? null : (
              <Fact label="Checkout session">
                <code>{review.intent.checkoutRef}</code>
              </Fact>
            )}
            {review.intent.paymentRef === null ? null : (
              <Fact label="Payment recorded">
                <code>{review.intent.paymentRef}</code>
              </Fact>
            )}
          </>
        )}
        <Fact label="Received">{formatUtc(review.receivedAt)}</Fact>
      </dl>

      {review.state === "resolved" ? (
        <dl className="flex flex-col gap-1 rounded-md bg-muted p-3 text-sm">
          <Fact label="Closed">
            {review.resolution === null
              ? "before closings were recorded"
              : `${formatUtc(review.resolution.at)} by ${review.resolution.byName ?? "a user who no longer exists"}`}
          </Fact>
          {review.resolution === null ? null : (
            <>
              <Fact label="Note">{review.resolution.note}</Fact>
              {review.resolution.entryId === null ? null : (
                <Fact label="Journal entry">
                  <code>{review.resolution.entryId}</code>
                </Fact>
              )}
            </>
          )}
        </dl>
      ) : (
        <form
          onSubmit={close}
          aria-label={`Deal with ${review.eventId}`}
          className="flex flex-col gap-3"
        >
          {suggestion === null ? null : (
            <Field
              data-invalid={
                localAmount !== undefined || amountIssue !== undefined
              }
            >
              <FieldLabel htmlFor={`${ids}-amount`}>Amount (USD)</FieldLabel>
              <Input
                id={`${ids}-amount`}
                inputMode="decimal"
                autoComplete="off"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                aria-invalid={
                  localAmount !== undefined || amountIssue !== undefined
                }
              />
              <FieldDescription>
                {suggestion.type === "credit"
                  ? suggestion.amountMicroUsd === null
                    ? "What the buyer actually paid, which Stripe shows. At most 10,000 at once."
                    : "Prefilled with what the top-up asked for. Change it to what the buyer actually paid."
                  : "A correction can be negative: -5 takes 5 away. At most 10,000 at once."}
              </FieldDescription>
              {localAmount !== undefined ? (
                <FieldError>{localAmount}</FieldError>
              ) : amountIssue === undefined ? null : (
                <FieldError>{describeBillingIssue(amountIssue)}</FieldError>
              )}
            </Field>
          )}
          <Field data-invalid={noteIssue !== undefined}>
            <FieldLabel htmlFor={`${ids}-note`}>Note</FieldLabel>
            <Textarea
              id={`${ids}-note`}
              value={note}
              maxLength={500}
              onChange={(event) => setNote(event.target.value)}
              aria-invalid={noteIssue !== undefined}
            />
            <FieldDescription>
              Required. Why the row is closed; it is kept with your name
              {suggestion === null
                ? ""
                : " and is the note of the journal entry when you credit"}
              .
            </FieldDescription>
            {noteIssue === undefined ? null : (
              <FieldError>{describeBillingIssue(noteIssue)}</FieldError>
            )}
          </Field>
          {suggestion?.type === "credit" &&
          review.intent !== null &&
          review.intent.state !== "paid" ? (
            <p className="text-sm text-muted-foreground">
              The top-up is not paid in our records yet. If Stripe took the
              payment, use Check payment first: a payment that Stripe delivers
              later is credited again beside a credit written here.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            {suggestion === null ? null : (
              <Button
                type="button"
                onClick={creditAndClose}
                loading={run.pending === "credit"}
                loadingLabel="Writing the entry"
              >
                {suggestion.type === "credit"
                  ? "Credit the workspace and close"
                  : "Correct the balance and close"}
              </Button>
            )}
            <Button
              type="submit"
              variant="secondary"
              loading={run.pending === "close"}
              loadingLabel="Closing the row"
            >
              Close without a credit
            </Button>
            {review.intent === null ? null : (
              <Button
                type="button"
                variant="ghost"
                onClick={checkPayment}
                loading={run.pending === "check"}
                loadingLabel="Asking Stripe"
              >
                Check payment
              </Button>
            )}
          </div>
          <OutcomeNote outcome={run.outcome} />
        </form>
      )}
    </li>
  );
}
