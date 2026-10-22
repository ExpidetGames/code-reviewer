// SPDX-License-Identifier: Apache-2.0

"use client";
// Adding credit (ADR 0006, P7, D3; #505): five preset amounts and another amount from $10 to $500, the business confirmation at the
// first top-up, and the redirect to the payment page of the provider. Nothing is credited here: the balance rises when the
// provider confirms the payment, and the page says so. With the manual adapter there is no form: the operator adds credit.
//
// The amount is typed in dollars and sent as whole cents; the server judges it again (10 to 500 dollars). One attempt is one
// intent id, made here and kept until an attempt fails, so a repeated click is the same payment and never two.
import { useId, useRef, useState, type FormEvent } from "react";
import { Button } from "../../components/button.tsx";
import { Checkbox } from "../../components/ui/checkbox.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import { Field, FieldError, FieldLabel } from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import {
  RadioGroup,
  RadioGroupItem,
} from "../../components/ui/radio-group.tsx";
import type { WorkspaceBillingApi } from "../api.ts";
import {
  BUSINESS_CONFIRMATION_LABEL,
  CUSTOM_AMOUNT_LABEL,
  describeBillingFailure,
  MANUAL_TOP_UP_TEXT,
  PAY_BUTTON,
  PAY_BUTTON_LOADING,
  PAYMENT_HINT,
  PRESET_LABEL,
  PRIVACY_LINK_TEXT,
  TERMS_LINK_TEXT,
  TOP_UP_EXPLAINER,
  TOP_UP_HEADING,
} from "../messages.ts";
import { parseTopUpCents } from "../money.ts";
import type { WorkspaceBillingView } from "../view.ts";
import { useAction } from "./use-action.ts";

/** The preset amounts, in whole US dollars. */
const PRESETS = [10, 25, 50, 100, 500] as const;
const DEFAULT_PRESET = 25;

export function TopUpCard({
  view,
  api,
  navigate,
  termsHref,
  privacyHref,
}: {
  view: WorkspaceBillingView;
  api: WorkspaceBillingApi;
  /** Goes to the payment page. Tests pass a stand-in; the page leaves the app. */
  navigate: (url: string) => void;
  /** The operator's terms, when the instance has set a link to them. */
  termsHref: string | null;
  /** The operator's privacy statement, when the instance has set a link to it. */
  privacyHref: string | null;
}) {
  const ids = useId();
  const { pending, outcome, run } = useAction();
  const [preset, setPreset] = useState<number>(DEFAULT_PRESET);
  const [custom, setCustom] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [local, setLocal] = useState<string | null>(null);
  const intentId = useRef<string>(crypto.randomUUID());

  const needsConfirmation =
    view.profileRequired && view.profile?.businessConfirmed !== true;
  const needsProfile = view.profileRequired && view.profile === null;

  if (!view.topUpAvailable)
    return (
      <Card role="region" aria-labelledby={`${ids}-heading`}>
        <CardHeader>
          <CardTitle>
            <h2
              id={`${ids}-heading`}
              className="text-lg font-semibold tracking-tight"
            >
              {TOP_UP_HEADING}
            </h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{MANUAL_TOP_UP_TEXT}</p>
        </CardContent>
      </Card>
    );

  function submit(event: FormEvent) {
    event.preventDefault();
    setLocal(null);
    // Another amount wins over the preset as soon as something is typed in it.
    const amount =
      custom.trim() === ""
        ? { ok: true as const, cents: preset * 100 }
        : parseTopUpCents(custom);
    if (!amount.ok) {
      setLocal(describeBillingFailure(amount.error));
      return;
    }
    if (needsProfile) {
      setLocal(describeBillingFailure("profile_required"));
      return;
    }
    if (needsConfirmation && !confirmed) {
      setLocal(describeBillingFailure("business_confirmation_required"));
      return;
    }
    void run(
      "pay",
      async () => {
        const result = await api.startTopUp({
          amountCents: amount.cents,
          confirmBusiness: needsConfirmation && confirmed,
          intentId: intentId.current,
        });
        if (!result.ok) {
          // The same attempt may be repeated only while the provider is still working on it.
          if (result.code !== "request_in_progress")
            intentId.current = crypto.randomUUID();
          return {
            kind: "failed",
            text: describeBillingFailure(result.code),
            issues: result.issues,
          };
        }
        navigate(result.data.url);
        return { kind: "ok", text: "" };
      },
      // Leaving the page: nothing to refresh.
      { refresh: false },
    );
  }

  const problem = local ?? (outcome?.kind === "failed" ? outcome.text : null);
  return (
    <Card role="region" aria-labelledby={`${ids}-heading`}>
      <CardHeader>
        <CardTitle>
          <h2
            id={`${ids}-heading`}
            className="text-lg font-semibold tracking-tight"
          >
            {TOP_UP_HEADING}
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">{TOP_UP_EXPLAINER}</p>
        <form
          onSubmit={submit}
          aria-label={TOP_UP_HEADING}
          className="flex flex-col gap-4"
        >
          <Field>
            <FieldLabel id={`${ids}-preset`}>{PRESET_LABEL}</FieldLabel>
            <RadioGroup
              value={custom.trim() === "" ? String(preset) : ""}
              onValueChange={(value) => {
                setPreset(Number(value));
                setCustom("");
                setLocal(null);
              }}
              aria-labelledby={`${ids}-preset`}
              className="flex flex-wrap gap-3"
            >
              {PRESETS.map((amount) => (
                <FieldLabel
                  key={amount}
                  htmlFor={`${ids}-preset-${String(amount)}`}
                  className="flex cursor-pointer items-center gap-2"
                >
                  <RadioGroupItem
                    value={String(amount)}
                    id={`${ids}-preset-${String(amount)}`}
                  />
                  <span>${amount}</span>
                </FieldLabel>
              ))}
            </RadioGroup>
          </Field>
          <Field data-invalid={local !== null}>
            <FieldLabel htmlFor={`${ids}-custom`}>
              {CUSTOM_AMOUNT_LABEL}
            </FieldLabel>
            <Input
              id={`${ids}-custom`}
              inputMode="decimal"
              autoComplete="off"
              value={custom}
              aria-invalid={local !== null}
              onChange={(event) => {
                setCustom(event.target.value);
                setLocal(null);
              }}
            />
          </Field>
          {needsConfirmation ? (
            <Field orientation="horizontal">
              <Checkbox
                id={`${ids}-business`}
                checked={confirmed}
                onCheckedChange={(checked) => {
                  setConfirmed(checked === true);
                  setLocal(null);
                }}
              />
              <FieldLabel
                htmlFor={`${ids}-business`}
                className="cursor-pointer font-normal"
              >
                {BUSINESS_CONFIRMATION_LABEL}
              </FieldLabel>
              {[
                [termsHref, TERMS_LINK_TEXT],
                [privacyHref, PRIVACY_LINK_TEXT],
              ].map(([href, text]) =>
                href === null ? null : (
                  <a
                    key={text}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-foreground"
                  >
                    {text}
                  </a>
                ),
              )}
            </Field>
          ) : null}
          {needsProfile ? (
            <p className="text-sm text-muted-foreground">
              {describeBillingFailure("profile_required")}
            </p>
          ) : null}
          {problem === null ? null : <FieldError>{problem}</FieldError>}
          <div className="flex flex-col gap-2">
            <div>
              <Button
                type="submit"
                disabled={needsProfile}
                loading={pending === "pay"}
                loadingLabel={PAY_BUTTON_LOADING}
              >
                {PAY_BUTTON}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{PAYMENT_HINT}</p>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
