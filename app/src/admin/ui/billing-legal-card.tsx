// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The links to the operator's terms and privacy statement (#626, ADR 0006, 2.14): the business confirmation at the first top-up
// of a workspace points to the terms, and billing cannot run on Stripe without that link. The privacy link is optional and is
// shown next to it. An https address of a public host; the server judges it, the page shows the sentence it gets back. A link
// can be changed while billing is on; the terms link of a Stripe setup that is on cannot be removed.
import { useProductIdentity } from "../../product-identity/context.tsx";
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../components/button.tsx";
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
import type { BillingApi } from "./billing-api.ts";
import {
  describeBillingFailure,
  describeBillingIssue,
} from "./billing-messages.ts";
import { OutcomeNote, useBillingRun } from "./billing-run.tsx";
import type { BillingView } from "./billing-view.ts";

type Draft = { termsUrl: string; privacyUrl: string };

export function BillingLegalCard({
  billing,
  api,
}: {
  billing: BillingView;
  api: BillingApi;
}) {
  const product = useProductIdentity();
  const ids = useId();
  const { pending, outcome, run } = useBillingRun();
  const [draft, setDraft] = useState<Draft>({
    termsUrl: billing.legal.termsUrl ?? "",
    privacyUrl: billing.legal.privacyUrl ?? "",
  });

  const problemOf = (field: keyof Draft): string | undefined => {
    if (outcome?.kind !== "failed") return undefined;
    const issue = outcome.issues.find(
      (entry) => entry.field === `legal.${field}`,
    );
    return issue === undefined ? undefined : describeBillingIssue(issue);
  };

  function submit(event: FormEvent) {
    event.preventDefault();
    // An emptied field is sent as an empty text: that removes the link.
    void run("save", async () => {
      const result = await api.change({ legal: draft });
      return result.ok
        ? { kind: "ok", text: "Saved." }
        : {
            kind: "failed",
            text: describeBillingFailure(product, result.code, result.status),
            issues: result.issues,
            missing: [],
          };
    });
  }

  const input = (field: keyof Draft, label: string, description: string) => {
    const problem = problemOf(field);
    return (
      <Field data-invalid={problem !== undefined}>
        <FieldLabel htmlFor={`${ids}-${field}`}>{label}</FieldLabel>
        <Input
          id={`${ids}-${field}`}
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder="https://"
          value={draft[field]}
          onChange={(event) =>
            setDraft((previous) => ({
              ...previous,
              [field]: event.target.value,
            }))
          }
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
      aria-label="Terms and privacy links"
      className="flex flex-col gap-4"
    >
      <Card role="region" aria-labelledby={`${ids}-legal`}>
        <CardHeader>
          <CardTitle>
            <h2
              id={`${ids}-legal`}
              className="text-lg font-semibold tracking-tight"
            >
              Terms and privacy
            </h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <p className="text-sm text-muted-foreground">
            A workspace that tops up for the first time confirms that it buys
            for business purposes, and the confirmation links to these pages.
          </p>
          {input(
            "termsUrl",
            "Link to the terms",
            "Needed to run Stripe: billing cannot be switched on with Stripe before it is set. Optional with the manual adapter.",
          )}
          {input(
            "privacyUrl",
            "Link to the privacy statement (optional)",
            "Shown next to the terms when it is set.",
          )}
        </CardContent>
      </Card>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          loading={pending === "save"}
          loadingLabel="Saving the links"
        >
          Save terms and privacy links
        </Button>
        <OutcomeNote outcome={outcome} />
      </div>
    </form>
  );
}
