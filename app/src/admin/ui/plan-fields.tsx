// SPDX-License-Identifier: Apache-2.0

"use client";
// The fields of the plans page (#438), shared by the editor of a plan and the form of a new one: the display fields that
// are edited in place, and the terms that make a version (key mode, limits, model access, prices). They only show and
// report what the admin types; `plans-format.ts` turns it into a request and the server judges it.
import { useId } from "react";
import { Checkbox } from "../../components/ui/checkbox.tsx";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import {
  RadioGroup,
  RadioGroupItem,
} from "../../components/ui/radio-group.tsx";
import { Switch } from "../../components/ui/switch.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import type { RequestIssue } from "../../ui/json-request.ts";
import { describePlanFailure } from "./plans-messages.ts";
import type { MetaForm, TermsForm } from "./plans-format.ts";
import type { CatalogChoice, PlanKind } from "./plans-view.ts";

export type FieldIssues = (field: string) => RequestIssue | undefined;

function IssueText({ issue }: { issue: RequestIssue | undefined }) {
  return issue === undefined ? null : (
    <FieldError>{describePlanFailure(issue.code)}</FieldError>
  );
}

/** Name, description, order, offered, Popular and, for an Enterprise plan, the contact target. */
export function MetadataFields({
  kind,
  form,
  onChange,
  issueOf,
  showKey = false,
}: {
  kind: PlanKind;
  form: MetaForm;
  onChange: (next: MetaForm) => void;
  issueOf: FieldIssues;
  /** A new plan chooses its key; an existing one cannot change it. */
  showKey?: boolean;
}) {
  const ids = useId();
  const set = <K extends keyof MetaForm>(key: K, value: MetaForm[K]) =>
    onChange({ ...form, [key]: value });
  return (
    <div className="flex flex-col gap-5">
      {showKey ? (
        <Field data-invalid={issueOf("planKey") !== undefined}>
          <FieldLabel htmlFor={`${ids}-key`}>Plan key</FieldLabel>
          <Input
            id={`${ids}-key`}
            spellCheck={false}
            autoComplete="off"
            value={form.planKey}
            onChange={(event) => set("planKey", event.target.value)}
            aria-invalid={issueOf("planKey") !== undefined}
          />
          <FieldDescription>
            Chosen once, never shown to customers: lower case letters, digits
            and hyphens.
          </FieldDescription>
          <IssueText issue={issueOf("planKey")} />
        </Field>
      ) : null}
      <Field data-invalid={issueOf("name") !== undefined}>
        <FieldLabel htmlFor={`${ids}-name`}>Name</FieldLabel>
        <Input
          id={`${ids}-name`}
          value={form.name}
          onChange={(event) => set("name", event.target.value)}
          aria-invalid={issueOf("name") !== undefined}
        />
        <IssueText issue={issueOf("name")} />
      </Field>
      <Field data-invalid={issueOf("description") !== undefined}>
        <FieldLabel htmlFor={`${ids}-description`}>Description</FieldLabel>
        <Textarea
          id={`${ids}-description`}
          rows={2}
          value={form.description}
          onChange={(event) => set("description", event.target.value)}
          aria-invalid={issueOf("description") !== undefined}
        />
        <IssueText issue={issueOf("description")} />
      </Field>
      <Field data-invalid={issueOf("sort") !== undefined}>
        <FieldLabel htmlFor={`${ids}-sort`}>Display order</FieldLabel>
        <Input
          id={`${ids}-sort`}
          inputMode="numeric"
          value={form.sort}
          onChange={(event) => set("sort", event.target.value)}
          aria-invalid={issueOf("sort") !== undefined}
        />
        <FieldDescription>
          The plan screen lists the plans from the lowest number to the highest.
          Plans with the same number are ordered by their key.
        </FieldDescription>
        <IssueText issue={issueOf("sort")} />
      </Field>
      {kind === "contact" ? (
        <Field data-invalid={issueOf("contactTarget") !== undefined}>
          <FieldLabel htmlFor={`${ids}-contact`}>
            Contact link or email
          </FieldLabel>
          <Input
            id={`${ids}-contact`}
            spellCheck={false}
            autoComplete="off"
            value={form.contactTarget}
            onChange={(event) => set("contactTarget", event.target.value)}
            aria-invalid={issueOf("contactTarget") !== undefined}
          />
          <FieldDescription>
            Behind the Contact us button: an https link, or an email address as
            mailto:name@example.com. The plan cannot be offered without it.
          </FieldDescription>
          <IssueText issue={issueOf("contactTarget")} />
        </Field>
      ) : null}
      <Field orientation="horizontal">
        <Switch
          id={`${ids}-offered`}
          checked={form.offered}
          onCheckedChange={(value) => set("offered", value)}
        />
        <FieldLabel htmlFor={`${ids}-offered`}>Offered</FieldLabel>
        <FieldDescription>
          Shown on the plan screen to new subscribers.
        </FieldDescription>
      </Field>
      <IssueText issue={issueOf("offered")} />
      {kind === "paid" ? (
        <Field orientation="horizontal">
          <Switch
            id={`${ids}-popular`}
            checked={form.popular}
            onCheckedChange={(value) => set("popular", value)}
          />
          <FieldLabel htmlFor={`${ids}-popular`}>Popular</FieldLabel>
          <FieldDescription>
            The Popular badge. At most one plan has it.
          </FieldDescription>
        </Field>
      ) : null}
      <IssueText issue={issueOf("popular")} />
    </div>
  );
}

/** Key mode, run limits, cost limits, model access and prices: what saving creates a new version of. */
export function TermsFields({
  kind,
  form,
  onChange,
  catalog,
  issueOf,
}: {
  kind: PlanKind;
  form: TermsForm;
  onChange: (next: TermsForm) => void;
  catalog: readonly CatalogChoice[];
  issueOf: FieldIssues;
}) {
  const ids = useId();
  const set = <K extends keyof TermsForm>(key: K, value: TermsForm[K]) =>
    onChange({ ...form, [key]: value });
  const own = kind !== "free" && form.keyMode === "own";

  function chooseKeyMode(value: string) {
    if (value === "own")
      // An own plan starts unlimited (a form default, not an amount); every limit stays editable.
      onChange({
        ...form,
        keyMode: "own",
        diffRuns: "",
        dynamicRuns: "",
        managedCostUsd: "",
      });
    else if (value === "managed") onChange({ ...form, keyMode: "managed" });
  }

  function toggleEntry(id: string, checked: boolean) {
    set(
      "entries",
      checked
        ? [...form.entries, id]
        : form.entries.filter((entry) => entry !== id),
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {kind === "free" ? (
        <FieldDescription>
          The Free plan always runs on our models. Its key mode cannot be
          changed.
        </FieldDescription>
      ) : (
        <Field data-invalid={issueOf("keyMode") !== undefined}>
          <FieldLabel id={`${ids}-key-mode`}>Key mode</FieldLabel>
          <RadioGroup
            value={form.keyMode}
            onValueChange={chooseKeyMode}
            aria-labelledby={`${ids}-key-mode`}
            className="gap-2"
          >
            {(
              [
                ["managed", "Our models"],
                ["own", "The workspace's own key"],
              ] as const
            ).map(([value, label]) => (
              <FieldLabel
                key={value}
                htmlFor={`${ids}-mode-${value}`}
                className="flex cursor-pointer items-center gap-3"
              >
                <RadioGroupItem value={value} id={`${ids}-mode-${value}`} />
                <span>{label}</span>
              </FieldLabel>
            ))}
          </RadioGroup>
          <FieldDescription>
            Our models: the operator&apos;s key and the catalog entries picked
            below. The workspace&apos;s own key: the workspace pays its provider
            and chooses provider and model itself.
          </FieldDescription>
          <IssueText issue={issueOf("keyMode")} />
        </Field>
      )}

      <FieldSet>
        <FieldLegend variant="label">Limits per month</FieldLegend>
        <Field data-invalid={issueOf("diffRunsPerPeriod") !== undefined}>
          <FieldLabel htmlFor={`${ids}-diff`}>Diff runs per month</FieldLabel>
          <Input
            id={`${ids}-diff`}
            inputMode="numeric"
            value={form.diffRuns}
            onChange={(event) => set("diffRuns", event.target.value)}
            aria-invalid={issueOf("diffRunsPerPeriod") !== undefined}
          />
          <IssueText issue={issueOf("diffRunsPerPeriod")} />
        </Field>
        <Field data-invalid={issueOf("dynamicRunsPerPeriod") !== undefined}>
          <FieldLabel htmlFor={`${ids}-dynamic`}>
            Dynamic runs per month
          </FieldLabel>
          <Input
            id={`${ids}-dynamic`}
            inputMode="numeric"
            value={form.dynamicRuns}
            onChange={(event) => set("dynamicRuns", event.target.value)}
            aria-invalid={issueOf("dynamicRunsPerPeriod") !== undefined}
          />
          <FieldDescription>
            Leave a limit empty for unlimited.
          </FieldDescription>
          <IssueText issue={issueOf("dynamicRunsPerPeriod")} />
        </Field>
        {own ? (
          <Field
            data-invalid={issueOf("ownKeyCostLimitMicroUsd") !== undefined}
          >
            <FieldLabel htmlFor={`${ids}-own-cost`}>
              Own-key cost limit (USD per month)
            </FieldLabel>
            <Input
              id={`${ids}-own-cost`}
              inputMode="decimal"
              value={form.ownKeyCostUsd}
              onChange={(event) => set("ownKeyCostUsd", event.target.value)}
              aria-invalid={issueOf("ownKeyCostLimitMicroUsd") !== undefined}
            />
            <FieldDescription>
              Optional: the measured model cost of the workspace&apos;s own
              runs.
            </FieldDescription>
            <IssueText issue={issueOf("ownKeyCostLimitMicroUsd")} />
          </Field>
        ) : (
          <Field
            data-invalid={issueOf("managedCostLimitMicroUsd") !== undefined}
          >
            <FieldLabel htmlFor={`${ids}-managed-cost`}>
              Operator cost limit (USD per month)
            </FieldLabel>
            <Input
              id={`${ids}-managed-cost`}
              inputMode="decimal"
              value={form.managedCostUsd}
              onChange={(event) => set("managedCostUsd", event.target.value)}
              aria-invalid={issueOf("managedCostLimitMicroUsd") !== undefined}
            />
            <FieldDescription>
              Optional: the measured model cost of runs on our key.
            </FieldDescription>
            <IssueText issue={issueOf("managedCostLimitMicroUsd")} />
          </Field>
        )}
      </FieldSet>

      {own ? null : (
        <Field data-invalid={issueOf("modelAccess") !== undefined}>
          <FieldLabel id={`${ids}-access`}>Models</FieldLabel>
          <RadioGroup
            value={form.accessAll ? "all" : "some"}
            onValueChange={(value) => set("accessAll", value === "all")}
            aria-labelledby={`${ids}-access`}
            className="gap-2"
          >
            {(
              [
                ["all", "Every released entry"],
                ["some", "Only the entries I pick"],
              ] as const
            ).map(([value, label]) => (
              <FieldLabel
                key={value}
                htmlFor={`${ids}-access-${value}`}
                className="flex cursor-pointer items-center gap-3"
              >
                <RadioGroupItem value={value} id={`${ids}-access-${value}`} />
                <span>{label}</span>
              </FieldLabel>
            ))}
          </RadioGroup>
          {form.accessAll ? null : (
            <div className="flex flex-col gap-2 pl-7">
              {catalog.length === 0 ? (
                <FieldDescription>
                  The catalog has no entries yet, so this plan allows no model
                  until you add some.
                </FieldDescription>
              ) : null}
              {catalog.map((entry) => (
                <FieldLabel
                  key={entry.id}
                  htmlFor={`${ids}-entry-${entry.id}`}
                  className="flex cursor-pointer items-center gap-3"
                >
                  <Checkbox
                    id={`${ids}-entry-${entry.id}`}
                    checked={form.entries.includes(entry.id)}
                    onCheckedChange={(checked) =>
                      toggleEntry(entry.id, checked === true)
                    }
                  />
                  <span>
                    {entry.name}{" "}
                    <span className="text-muted-foreground">
                      {entry.provider} · {entry.modelId} ({entry.status})
                    </span>
                  </span>
                </FieldLabel>
              ))}
            </div>
          )}
          <IssueText issue={issueOf("modelAccess")} />
        </Field>
      )}
      {own ? (
        <FieldDescription>
          A plan that uses the workspace&apos;s own key has no model list:
          workspaces choose any model their keys allow.
        </FieldDescription>
      ) : null}

      {kind === "paid" ? (
        <FieldSet>
          <FieldLegend variant="label">Prices</FieldLegend>
          <Field data-invalid={issueOf("monthlyAmountMinor") !== undefined}>
            <FieldLabel htmlFor={`${ids}-monthly`}>
              Monthly price (USD, tax included)
            </FieldLabel>
            <Input
              id={`${ids}-monthly`}
              inputMode="decimal"
              value={form.monthly}
              onChange={(event) => set("monthly", event.target.value)}
              aria-invalid={issueOf("monthlyAmountMinor") !== undefined}
            />
            <IssueText issue={issueOf("monthlyAmountMinor")} />
          </Field>
          <Field data-invalid={issueOf("yearlyAmountMinor") !== undefined}>
            <FieldLabel htmlFor={`${ids}-yearly`}>
              Yearly price (USD, tax included, optional)
            </FieldLabel>
            <Input
              id={`${ids}-yearly`}
              inputMode="decimal"
              value={form.yearly}
              onChange={(event) => set("yearly", event.target.value)}
              aria-invalid={issueOf("yearlyAmountMinor") !== undefined}
            />
            <FieldDescription>
              The price for a whole year, as an amount, not a discount. Leave it
              empty for no yearly option.
            </FieldDescription>
            <IssueText issue={issueOf("yearlyAmountMinor")} />
          </Field>
        </FieldSet>
      ) : null}
    </div>
  );
}
