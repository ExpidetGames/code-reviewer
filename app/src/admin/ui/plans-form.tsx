// SPDX-License-Identifier: Apache-2.0

"use client";
// The plans page of the admin portal (#438, ADR 0005, 2.11): the plans in display order with their current version, an
// editor for each, and a form for a new plan. Everything here is the instance admin's, and only while billing is on:
// while it is off the page says so and reads nothing. The server judges every step and the page shows the reason it gets
// back.
import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../components/button.tsx";
import { HelpDisclosure } from "../../components/help-disclosure.tsx";
import { StatusRegion } from "../../components/status-region.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import { Field, FieldLabel } from "../../components/ui/field.tsx";
import {
  RadioGroup,
  RadioGroupItem,
} from "../../components/ui/radio-group.tsx";
import type { RequestIssue } from "../../ui/json-request.ts";
import { MetadataFields, TermsFields } from "./plan-fields.tsx";
import { PlanEditor } from "./plan-editor.tsx";
import {
  browserPlansApi,
  type NewPlanBody,
  type PlansApi,
  type PlansWriteAnswer,
} from "./plans-api.ts";
import {
  describeLimit,
  describeModelAccess,
  describePrice,
  emptyMetaForm,
  emptyTermsForm,
  metadataFromForm,
  termsFromForm,
  type MetaForm,
  type TermsForm,
} from "./plans-format.ts";
import { describePlanFailure } from "./plans-messages.ts";
import type {
  PlanKind,
  PlanVersionView,
  PlanView,
  PlansView,
} from "./plans-view.ts";

const KIND_WORDS: Record<PlanKind, string> = {
  free: "Free",
  paid: "Paid",
  contact: "Enterprise",
};

function VersionSummary({
  version,
  catalog,
}: {
  version: PlanVersionView;
  catalog: PlansView["catalog"];
}) {
  const own = version.keyMode === "own";
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
      <dt className="text-muted-foreground">Current</dt>
      <dd>Version {version.number}</dd>
      <dt className="text-muted-foreground">Key mode</dt>
      <dd>{own ? "The workspace's own key" : "Our models"}</dd>
      <dt className="text-muted-foreground">Diff runs per month</dt>
      <dd>{describeLimit(version.limits.diffRunsPerPeriod)}</dd>
      <dt className="text-muted-foreground">Dynamic runs per month</dt>
      <dd>{describeLimit(version.limits.dynamicRunsPerPeriod)}</dd>
      <dt className="text-muted-foreground">Models</dt>
      <dd>{describeModelAccess(version.modelAccess, catalog)}</dd>
      {version.monthlyAmountMinor === null ? null : (
        <>
          <dt className="text-muted-foreground">Monthly</dt>
          <dd>{describePrice(version.monthlyAmountMinor)}</dd>
          <dt className="text-muted-foreground">Yearly</dt>
          <dd>
            {version.yearlyAmountMinor === null
              ? "No yearly option"
              : describePrice(version.yearlyAmountMinor)}
          </dd>
        </>
      )}
    </dl>
  );
}

function PlanCard({
  plan,
  view,
  open,
  onToggle,
  api,
  onDone,
}: {
  plan: PlanView;
  view: PlansView;
  open: boolean;
  onToggle: () => void;
  api: PlansApi;
  onDone: (answer: PlansWriteAnswer, message: string) => void;
}) {
  const ids = useId();
  const current = plan.versions.find((version) => version.role === "current");
  const earlier = plan.versions.filter((version) => version.role === "legacy");
  return (
    <Card role="region" aria-labelledby={`${ids}-name`}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <h3 id={`${ids}-name`} className="text-lg font-semibold">
            {plan.name}
          </h3>
          <Badge variant="neutral">{KIND_WORDS[plan.kind]}</Badge>
          {plan.popular ? <Badge variant="info">Popular</Badge> : null}
          {plan.archived ? (
            <Badge variant="warning">Archived</Badge>
          ) : plan.offered ? null : (
            <Badge variant="neutral">Not offered</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {plan.description === "" ? null : (
          <p className="text-sm text-muted-foreground">{plan.description}</p>
        )}
        {plan.kind === "contact" ? (
          <p className="text-sm">
            Contact us:{" "}
            {plan.contactTarget === null ? (
              <span className="text-muted-foreground">no target yet</span>
            ) : (
              <span>{plan.contactTarget}</span>
            )}
          </p>
        ) : current === undefined ? null : (
          <VersionSummary version={current} catalog={view.catalog} />
        )}
        {earlier.length === 0 ? null : (
          <p className="text-sm text-muted-foreground">
            Earlier versions, kept for their subscribers:{" "}
            {earlier.map((version) => version.number).join(", ")}.
          </p>
        )}
        <div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            aria-expanded={open}
            aria-label={open ? `Close ${plan.name}` : `Edit ${plan.name}`}
            onClick={onToggle}
          >
            {open ? "Close" : "Edit"}
          </Button>
        </div>
        {open ? (
          <PlanEditor plan={plan} view={view} api={api} onDone={onDone} />
        ) : null}
      </CardContent>
    </Card>
  );
}

type NewKind = "paid" | "contact";

function NewPlanForm({
  view,
  api,
  onDone,
  onCancel,
}: {
  view: PlansView;
  api: PlansApi;
  onDone: (answer: PlansWriteAnswer, message: string) => void;
  onCancel: () => void;
}) {
  const ids = useId();
  const [kind, setKind] = useState<NewKind>("paid");
  const [meta, setMeta] = useState<MetaForm>(emptyMetaForm());
  const [terms, setTerms] = useState<TermsForm>(emptyTermsForm("paid"));
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{
    text: string;
    issues: RequestIssue[];
  } | null>(null);
  const [local, setLocal] = useState<RequestIssue[]>([]);

  const issues = [...local, ...(failure?.issues ?? [])];
  const issueOf = (field: string) =>
    issues.find((issue) => issue.field === field);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    const checkedMeta = metadataFromForm(kind, meta);
    const checkedTerms =
      kind === "paid" ? termsFromForm("paid", terms) : undefined;
    const problems = [
      ...(checkedMeta.ok ? [] : checkedMeta.issues),
      ...(checkedTerms === undefined || checkedTerms.ok
        ? []
        : checkedTerms.issues),
    ];
    setLocal(problems);
    if (!checkedMeta.ok || problems.length > 0) return;
    const body: NewPlanBody = {
      planKey: meta.planKey.trim(),
      kind,
      ...checkedMeta.metadata,
      ...(checkedTerms?.ok ? { terms: checkedTerms.terms } : {}),
    };
    setPending(true);
    const result = await api.create(body);
    setPending(false);
    if (!result.ok) {
      setFailure({
        text: describePlanFailure(result.code),
        issues: result.issues,
      });
      return;
    }
    onDone(result.data, `${checkedMeta.metadata.name} created.`);
  }

  return (
    <form
      aria-label="New plan"
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-5 rounded-lg border p-4"
    >
      <h3 className="text-lg font-semibold">New plan</h3>
      <Field>
        <FieldLabel id={`${ids}-kind`}>Kind</FieldLabel>
        <RadioGroup
          value={kind}
          onValueChange={(value) => {
            if (value === "paid" || value === "contact") setKind(value);
          }}
          aria-labelledby={`${ids}-kind`}
          className="gap-2"
        >
          {(
            [
              ["paid", "Paid plan"],
              ["contact", "Enterprise"],
            ] as const
          ).map(([value, label]) => (
            <FieldLabel
              key={value}
              htmlFor={`${ids}-${value}`}
              className="flex cursor-pointer items-center gap-3"
            >
              <RadioGroupItem value={value} id={`${ids}-${value}`} />
              <span>{label}</span>
            </FieldLabel>
          ))}
        </RadioGroup>
      </Field>
      <MetadataFields
        kind={kind}
        form={meta}
        onChange={setMeta}
        issueOf={issueOf}
        showKey
      />
      {kind === "paid" ? (
        <TermsFields
          kind="paid"
          form={terms}
          onChange={setTerms}
          catalog={view.catalog}
          issueOf={issueOf}
        />
      ) : null}
      {failure !== null &&
      issues.length === failure.issues.length &&
      failure.issues.length === 0 ? (
        <Alert variant="destructive" role="note">
          <AlertDescription>{failure.text}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex gap-3">
        <Button
          type="submit"
          loading={pending}
          loadingLabel="Creating the plan"
        >
          Create plan
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function PlansForm({
  billingOn,
  initial,
  api = browserPlansApi,
}: {
  billingOn: boolean;
  /** The plans as the server read them; `null` while billing is off (nothing is read). */
  initial: PlansView | null;
  /** Only tests pass this. */
  api?: PlansApi;
}) {
  const [view, setView] = useState<PlansView | null>(initial);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (!billingOn || view === null)
    return (
      <Alert variant="warning" role="note">
        <AlertDescription>
          Billing is off, so there are no plans to show or change. Switch
          billing on first; the Free plan is created then. Open the{" "}
          <Link href="/admin/billing" className="underline">
            billing settings
          </Link>
          .
        </AlertDescription>
      </Alert>
    );

  function done(answer: PlansWriteAnswer, message: string) {
    setView(answer.plans);
    setNotice(message);
    setOpenKey(null);
    setCreating(false);
  }

  return (
    <div className="flex flex-col gap-6">
      <HelpDisclosure label="How this works">
        A plan is what you sell. Saving a change to its price, limits, key mode
        or models creates a new version, and the people who bought the old
        version keep it. The name, description, order, Popular badge and
        Enterprise contact target change in place. The Free plan is the default
        of every workspace without a subscription; it uses only our models and
        has no price. Prices are whatever you enter here, in US dollars
        including tax.
      </HelpDisclosure>

      {view.warnings.includes("own_key_workspaces_without_own_plan") ? (
        <Alert variant="warning" role="note">
          <AlertDescription>
            {view.ownKeyWorkspaces}{" "}
            {view.ownKeyWorkspaces === 1
              ? "workspace holds"
              : "workspaces hold"}{" "}
            their own LLM key, but no plan that uses the workspace&apos;s own
            key is offered. While billing is on their reviews stop until they
            buy such a plan or delete the key. Create a paid plan with the key
            mode &quot;The workspace&apos;s own key&quot; and offer it.
          </AlertDescription>
        </Alert>
      ) : null}

      <StatusRegion>{notice}</StatusRegion>

      <div className="flex flex-col gap-4">
        {view.plans.map((plan) => (
          <PlanCard
            key={plan.planKey}
            plan={plan}
            view={view}
            open={openKey === plan.planKey}
            onToggle={() =>
              setOpenKey(openKey === plan.planKey ? null : plan.planKey)
            }
            api={api}
            onDone={done}
          />
        ))}
      </div>

      {creating ? (
        <NewPlanForm
          view={view}
          api={api}
          onDone={done}
          onCancel={() => setCreating(false)}
        />
      ) : (
        <div>
          <Button
            type="button"
            onClick={() => {
              setOpenKey(null);
              setCreating(true);
            }}
          >
            New plan
          </Button>
        </div>
      )}
    </div>
  );
}
