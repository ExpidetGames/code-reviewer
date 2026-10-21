// SPDX-License-Identifier: Apache-2.0

"use client";
// The billing details of the workspace (ADR 0006, 2.13; #505): the legal name and address that go on the receipt, and an optional
// VAT ID. Only an Owner or an Admin ever receives them. The server judges every field and names the field and a code, never the
// value; this card shows the sentence of the code under the field and keeps what was typed. The business confirmation is not
// here: it is given with the first top-up.
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../components/button.tsx";
import { StatusRegion } from "../../components/status-region.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { Field, FieldError, FieldLabel } from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import type { WorkspaceBillingApi } from "../api.ts";
import {
  describeBillingFailure,
  describeProfileIssue,
  PROFILE_EXPLAINER,
  PROFILE_FIELD_LABELS,
  PROFILE_HEADING,
  PROFILE_SAVE_BUTTON,
  PROFILE_SAVED_TEXT,
} from "../messages.ts";
import type { BillingProfileFormView } from "../view.ts";
import { issueOf, useAction } from "./use-action.ts";

const FIELDS = [
  "legalName",
  "addressLine1",
  "addressLine2",
  "postalCode",
  "city",
  "country",
  "vatId",
] as const;
type FieldName = (typeof FIELDS)[number];
type Draft = Record<FieldName, string>;

function draftOf(profile: BillingProfileFormView | null): Draft {
  return {
    legalName: profile?.legalName ?? "",
    addressLine1: profile?.addressLine1 ?? "",
    addressLine2: profile?.addressLine2 ?? "",
    postalCode: profile?.postalCode ?? "",
    city: profile?.city ?? "",
    country: profile?.country ?? "",
    vatId: profile?.vatId ?? "",
  };
}

export function ProfileCard({
  profile,
  api,
}: {
  profile: BillingProfileFormView | null;
  api: WorkspaceBillingApi;
}) {
  const ids = useId();
  const { pending, outcome, run } = useAction();
  const [draft, setDraft] = useState<Draft>(() => draftOf(profile));

  const set = (field: FieldName) => (value: string) =>
    setDraft((previous) => ({ ...previous, [field]: value }));

  function submit(event: FormEvent) {
    event.preventDefault();
    const optional = (value: string) =>
      value.trim() === "" ? null : value.trim();
    void run("save", async () => {
      const result = await api.saveProfile({
        legalName: draft.legalName.trim(),
        country: draft.country.trim(),
        addressLine1: draft.addressLine1.trim(),
        addressLine2: optional(draft.addressLine2),
        postalCode: draft.postalCode.trim(),
        city: draft.city.trim(),
        vatId: optional(draft.vatId),
      });
      if (!result.ok)
        return {
          kind: "failed",
          text: describeBillingFailure(result.code),
          issues: result.issues,
        };
      return { kind: "ok", text: PROFILE_SAVED_TEXT };
    });
  }

  return (
    <Card role="region" aria-labelledby={`${ids}-profile`}>
      <CardHeader>
        <CardTitle>
          <h2
            id={`${ids}-profile`}
            className="text-lg font-semibold tracking-tight"
          >
            {PROFILE_HEADING}
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">{PROFILE_EXPLAINER}</p>
        <form
          onSubmit={submit}
          aria-label={PROFILE_HEADING}
          className="grid gap-4 sm:grid-cols-2"
        >
          {FIELDS.map((field) => {
            const issue = issueOf(outcome, field);
            return (
              <Field
                key={field}
                data-invalid={issue !== undefined}
                className={field === "legalName" ? "sm:col-span-2" : undefined}
              >
                <FieldLabel htmlFor={`${ids}-${field}`}>
                  {PROFILE_FIELD_LABELS[field]}
                </FieldLabel>
                <Input
                  id={`${ids}-${field}`}
                  value={draft[field]}
                  autoComplete="off"
                  aria-invalid={issue !== undefined}
                  onChange={(event) => set(field)(event.target.value)}
                />
                {issue === undefined ? null : (
                  <FieldError>{describeProfileIssue(issue)}</FieldError>
                )}
              </Field>
            );
          })}
          <div className="flex flex-col gap-3 sm:col-span-2">
            <div>
              <Button
                type="submit"
                variant="secondary"
                loading={pending === "save"}
                loadingLabel="Saving the billing details"
              >
                {PROFILE_SAVE_BUTTON}
              </Button>
            </div>
            <StatusRegion>
              {outcome === null ? null : (
                <Alert
                  variant={outcome.kind === "ok" ? "success" : "destructive"}
                  role="note"
                >
                  <AlertDescription>{outcome.text}</AlertDescription>
                </Alert>
              )}
            </StatusRegion>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
