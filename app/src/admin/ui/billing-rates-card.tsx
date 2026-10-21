// SPDX-License-Identifier: Apache-2.0

"use client";
// The rates and numbers of billing (#504, ADR 0006, D2, D3, D9, D10): the factor A of the AI cost on our models, the rate per
// started minute for Diff and for Dynamic reviews in US dollars, the AI reserve of a Diff review, the start credit, the
// low-balance threshold and the hidden hourly brake. The page shows and takes decimals (`billing-money.ts`); what is stored is
// whole numbers (parts per 10,000 for A, micro-USD for the money). No rate has a default: billing cannot be on before A and
// both rates are set. The start credit is 2 US dollars until it is changed (0 switches it off). A rate can be changed any
// time, also while billing is on.
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../components/button.tsx";
import { InfoHint } from "../../components/info-hint.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import type { BillingApi, BillingRatesChange } from "./billing-api.ts";
import {
  formatFactor,
  formatUsd,
  parseFactor,
  parseUsd,
  parseWhole,
} from "./billing-money.ts";
import {
  describeBillingFailure,
  describeBillingIssue,
} from "./billing-messages.ts";
import { OutcomeNote, useBillingRun } from "./billing-run.tsx";
import type { BillingView } from "./billing-view.ts";

type Draft = {
  factorA: string;
  diffRate: string;
  dynamicRate: string;
  reserve: string;
  startCredit: string;
  lowBalance: string;
  hourlyLimit: string;
};

function draftOf(billing: BillingView): Draft {
  const { rates, numbers } = billing;
  return {
    factorA: rates.factorA === null ? "" : formatFactor(rates.factorA),
    diffRate:
      rates.diffMinuteRateMicroUsd === null
        ? ""
        : formatUsd(rates.diffMinuteRateMicroUsd),
    dynamicRate:
      rates.dynamicMinuteRateMicroUsd === null
        ? ""
        : formatUsd(rates.dynamicMinuteRateMicroUsd),
    reserve:
      rates.diffAiReserveMicroUsd === null
        ? ""
        : formatUsd(rates.diffAiReserveMicroUsd),
    startCredit: formatUsd(numbers.startCreditMicroUsd),
    lowBalance: formatUsd(numbers.lowBalanceMicroUsd),
    hourlyLimit: String(numbers.hourlyReviewLimit),
  };
}

/** The field of the answer's issue (`minuteRateMicroUsd.diff`) for the input it is about. */
const INPUT_OF: Record<string, keyof Draft> = {
  factorA: "factorA",
  "minuteRateMicroUsd.diff": "diffRate",
  "minuteRateMicroUsd.dynamic": "dynamicRate",
  diffAiReserveMicroUsd: "reserve",
  startCreditMicroUsd: "startCredit",
  lowBalanceMicroUsd: "lowBalance",
  hourlyReviewLimit: "hourlyLimit",
};

type Local = Partial<Record<keyof Draft, string>>;

export function BillingRatesCard({
  billing,
  api,
}: {
  billing: BillingView;
  api: BillingApi;
}) {
  const ids = useId();
  const { pending, outcome, run } = useBillingRun();
  const [draft, setDraft] = useState<Draft>(() => draftOf(billing));
  // Fields the text of which could not be read as a number, found before anything is sent.
  const [local, setLocal] = useState<Local>({});

  const set = (field: keyof Draft) => (value: string) => {
    setDraft((previous) => ({ ...previous, [field]: value }));
    setLocal((previous) => ({ ...previous, [field]: undefined }));
  };

  /** The sentence under an input: what the browser could not read, or what the server refused. */
  const problemOf = (field: keyof Draft): string | undefined => {
    const own = local[field];
    if (own !== undefined) return own;
    if (outcome?.kind !== "failed") return undefined;
    const issue = outcome.issues.find(
      (entry) => INPUT_OF[entry.field] === field,
    );
    return issue === undefined ? undefined : describeBillingIssue(issue);
  };

  function submit(event: FormEvent) {
    event.preventDefault();
    const problems: Local = {};
    const rates: BillingRatesChange = {};
    const initial = draftOf(billing);
    const { rates: now, numbers } = billing;
    // A blank field that is not set yet stays unset; a blank field of a value that is set is a mistake, not a removal. A
    // number that has a default and was never stored is sent only when the admin changed it, so saving the rates does not
    // freeze the default.
    const read = <T,>(
      field: keyof Draft,
      parse: (text: string) => T | null,
      stored: boolean,
      code: string,
      assign: (value: T) => void,
    ) => {
      const text = draft[field];
      if (!stored && text === initial[field]) return;
      const value = parse(text);
      if (value === null)
        problems[field] = describeBillingIssue({ field, code });
      else assign(value);
    };
    read(
      "factorA",
      parseFactor,
      now.factorA !== null,
      "factor_invalid",
      (value) => {
        rates.factorA = value;
      },
    );
    read(
      "diffRate",
      parseUsd,
      now.diffMinuteRateMicroUsd !== null,
      "rate_invalid",
      (value) => {
        rates.minuteRateMicroUsd = { ...rates.minuteRateMicroUsd, diff: value };
      },
    );
    read(
      "dynamicRate",
      parseUsd,
      now.dynamicMinuteRateMicroUsd !== null,
      "rate_invalid",
      (value) => {
        rates.minuteRateMicroUsd = {
          ...rates.minuteRateMicroUsd,
          dynamic: value,
        };
      },
    );
    read(
      "reserve",
      parseUsd,
      now.diffAiReserveMicroUsd !== null,
      "reserve_invalid",
      (value) => {
        rates.diffAiReserveMicroUsd = value;
      },
    );
    read(
      "startCredit",
      parseUsd,
      numbers.startCreditStored,
      "start_credit_invalid",
      (value) => {
        rates.startCreditMicroUsd = value;
      },
    );
    read(
      "lowBalance",
      parseUsd,
      numbers.lowBalanceStored,
      "low_balance_invalid",
      (value) => {
        rates.lowBalanceMicroUsd = value;
      },
    );
    read(
      "hourlyLimit",
      parseWhole,
      numbers.hourlyReviewLimitStored,
      "hourly_limit_invalid",
      (value) => {
        rates.hourlyReviewLimit = value;
      },
    );
    setLocal(problems);
    if (Object.keys(problems).length > 0) return;
    void run("save", async () => {
      const result = await api.change({ rates });
      return result.ok
        ? { kind: "ok", text: "Saved." }
        : {
            kind: "failed",
            text: describeBillingFailure(result.code),
            issues: result.issues,
            missing: [],
          };
    });
  }

  const input = (
    field: keyof Draft,
    label: string,
    description: string,
    hint?: string,
  ) => {
    const problem = problemOf(field);
    return (
      <Field data-invalid={problem !== undefined}>
        <div className="flex items-center gap-1">
          <FieldLabel htmlFor={`${ids}-${field}`}>{label}</FieldLabel>
          {hint === undefined ? null : (
            <InfoHint label={`About ${label}`}>{hint}</InfoHint>
          )}
        </div>
        <Input
          id={`${ids}-${field}`}
          inputMode="decimal"
          autoComplete="off"
          value={draft[field]}
          onChange={(event) => set(field)(event.target.value)}
          aria-invalid={problem !== undefined}
        />
        <FieldDescription>{description}</FieldDescription>
        {problem === undefined ? null : <FieldError>{problem}</FieldError>}
      </Field>
    );
  };

  return (
    <form
      onSubmit={submit}
      aria-label="Rates and numbers"
      className="flex flex-col gap-4"
    >
      <Card role="region" aria-labelledby={`${ids}-rates`}>
        <CardHeader>
          <CardTitle>
            <h2
              id={`${ids}-rates`}
              className="text-lg font-semibold tracking-tight"
            >
              Rates and numbers
            </h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <p className="text-sm text-muted-foreground">
            A review costs its AI cost times the factor A (on your models only)
            plus its started minutes times the rate of its kind. None of these
            has a default: billing cannot be on before the factor A, both rates
            and the AI reserve are set.
          </p>
          {input(
            "factorA",
            "Factor A",
            "Multiplies the real AI cost of a review on your models. 5 charges five times the cost; 1.2 charges 20 percent more. At least 1.",
          )}
          {input(
            "diffRate",
            "Rate per started minute, Diff reviews (USD)",
            "For example 0.013. A minute that has started is charged whole.",
          )}
          {input(
            "dynamicRate",
            "Rate per started minute, Dynamic reviews (USD)",
            "For example 0.016.",
          )}
          {input(
            "reserve",
            "AI reserve per Diff review (USD)",
            "Real model cost before the factor A. The AI part of the hold a Diff review takes when it starts; the charge is what the run really cost.",
            "A Diff review has no cost cap, so a hold of this size keeps a workspace with little balance from starting a review it cannot pay. At A = 5, a reserve of 0.15 holds 0.75 USD.",
          )}
          {input(
            "startCredit",
            "Start credit (USD)",
            "Granted once to a new GitHub account's first workspace. 0 switches the grant off. Until you change it, 2 is in force.",
          )}
          {input(
            "lowBalance",
            "Low-balance threshold (USD)",
            "A balance below this is low. The mail to the owners and admins of the workspace is sent once when it falls below. Until you change it, 5 is in force.",
          )}
          {input(
            "hourlyLimit",
            "Hourly review limit per workspace",
            "The most reviews a workspace can start in a rolling hour; a hidden abuse brake whose number is never shown to a workspace. Until you change it, 60 is in force.",
          )}
        </CardContent>
      </Card>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          loading={pending === "save"}
          loadingLabel="Saving the rates and numbers"
        >
          Save rates and numbers
        </Button>
        <OutcomeNote outcome={outcome} />
      </div>
    </form>
  );
}
