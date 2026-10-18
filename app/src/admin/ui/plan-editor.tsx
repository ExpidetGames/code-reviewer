// SPDX-License-Identifier: Apache-2.0

"use client";
// The editor of one plan (#438): the display fields that change in place, the terms that make a version (a change
// asks for a confirmation that names the version and says subscribers keep theirs), archive, and delete for an
// Enterprise plan. The server judges every value; the form only keeps a typo from becoming a request.
import { useState, type FormEvent } from "react";
import { Button } from "../../components/button.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import type { RequestIssue, RequestResult } from "../../ui/json-request.ts";
import { MetadataFields, TermsFields } from "./plan-fields.tsx";
import { PlanPriceCreate } from "./plan-price-create.tsx";
import { PlanPrices } from "./plan-prices.tsx";
import type { PlanChange, PlansApi, PlansWriteAnswer } from "./plans-api.ts";
import {
  emptyTermsForm,
  metaFormFrom,
  metadataFromForm,
  termsFormFrom,
  termsFromForm,
  type MetaForm,
  type TermsForm,
} from "./plans-format.ts";
import { describePlanFailure } from "./plans-messages.ts";
import type { PlanTerms, PlanView, PlansView } from "./plans-view.ts";

const KEY_MODE_WORDS = {
  managed: "our models",
  own: "the workspace's own key",
} as const;

type Confirmation =
  | { kind: "terms"; terms: PlanTerms }
  | { kind: "popular"; from: string }
  | { kind: "delete" }
  | null;

type Failure = { text: string; issues: RequestIssue[] } | null;

export function PlanEditor({
  plan,
  view,
  api,
  onDone,
}: {
  plan: PlanView;
  view: PlansView;
  api: PlansApi;
  /** A write went through: the whole new list and a sentence for the page. */
  onDone: (answer: PlansWriteAnswer, message: string) => void;
}) {
  const current = plan.versions.find((version) => version.role === "current");
  const [meta, setMeta] = useState<MetaForm>(metaFormFrom(plan));
  const [terms, setTerms] = useState<TermsForm>(
    current === undefined ? emptyTermsForm(plan.kind) : termsFormFrom(current),
  );
  const [confirm, setConfirm] = useState<Confirmation>(null);
  const [failure, setFailure] = useState<Failure>(null);
  const [local, setLocal] = useState<RequestIssue[]>([]);
  const [pending, setPending] = useState(false);

  const issues = [...local, ...(failure?.issues ?? [])];
  const issueOf = (field: string) =>
    issues.find((issue) => issue.field === field);
  // A refusal that names a field the form shows is shown at the field; any other is shown as a sentence.
  const SHOWN = new Set([
    "name",
    "description",
    "sort",
    "offered",
    "popular",
    "contactTarget",
    "keyMode",
    "diffRunsPerPeriod",
    "dynamicRunsPerPeriod",
    "managedCostLimitMicroUsd",
    "ownKeyCostLimitMicroUsd",
    "modelAccess",
    "monthlyAmountMinor",
    "yearlyAmountMinor",
  ]);
  const unshown =
    failure !== null &&
    (failure.issues.length === 0 ||
      !failure.issues.every((issue) => SHOWN.has(issue.field)));

  async function send(
    request: Promise<RequestResult<PlansWriteAnswer>>,
    message: (answer: PlansWriteAnswer) => string,
  ) {
    setPending(true);
    setFailure(null);
    setLocal([]);
    const result = await request;
    setPending(false);
    setConfirm(null);
    if (!result.ok) {
      setFailure({
        text: describePlanFailure(result.code),
        issues: result.issues,
      });
      return;
    }
    onDone(result.data, message(result.data));
  }

  const changeOf = (change: PlanChange) => api.change(plan.planKey, change);

  function saveMeta(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    const checked = metadataFromForm(plan.kind, meta);
    if (!checked.ok) {
      setLocal(checked.issues);
      return;
    }
    setLocal([]);
    const other = view.plans.find(
      (candidate) => candidate.popular && candidate.planKey !== plan.planKey,
    );
    if (checked.metadata.popular && !plan.popular && other !== undefined) {
      setConfirm({ kind: "popular", from: other.name });
      return;
    }
    void sendMeta();
  }

  function sendMeta() {
    const checked = metadataFromForm(plan.kind, meta);
    if (!checked.ok) return;
    return send(changeOf({ metadata: checked.metadata }), (answer) => {
      const lost =
        answer.clearedPopular === null
          ? undefined
          : view.plans.find((p) => p.planKey === answer.clearedPopular);
      return `${checked.metadata.name} saved.${
        lost === undefined
          ? ""
          : ` ${lost.name} no longer has the Popular badge.`
      }`;
    });
  }

  function saveTerms(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    const checked = termsFromForm(plan.kind, terms);
    if (!checked.ok) {
      setLocal(checked.issues);
      return;
    }
    setLocal([]);
    setConfirm({ kind: "terms", terms: checked.terms });
  }

  const nextNumber = (current?.number ?? 0) + 1;

  function confirmTerms(next: PlanTerms) {
    return send(
      changeOf({
        terms: { basedOnVersion: current?.number ?? 0, terms: next },
      }),
      () =>
        plan.kind === "free"
          ? `Version ${nextNumber} of ${plan.name} created. It applies to every Free workspace now.`
          : `Version ${nextNumber} of ${plan.name} created. Existing subscribers keep theirs.`,
    );
  }

  const termsSentence = (next: PlanTerms) => {
    const first =
      plan.kind === "free"
        ? `This creates version ${nextNumber} of ${plan.name}. The Free plan has no subscribers: the new version applies to every Free workspace at once.`
        : `This creates version ${nextNumber} of ${plan.name}. Existing subscribers keep version ${current?.number ?? 0}.`;
    const changedMode =
      current !== undefined && current.keyMode !== next.keyMode
        ? ` It also changes the key mode from ${KEY_MODE_WORDS[current.keyMode]} to ${KEY_MODE_WORDS[next.keyMode]}.`
        : "";
    return first + changedMode;
  };

  return (
    <div className="flex flex-col gap-6 border-t pt-4">
      {failure !== null && unshown ? (
        <Alert variant="destructive" role="note">
          <AlertDescription>{failure.text}</AlertDescription>
        </Alert>
      ) : null}

      <form
        aria-label={`Display settings of ${plan.name}`}
        onSubmit={saveMeta}
        className="flex flex-col gap-4"
      >
        <h4 className="font-medium">Display settings</h4>
        <MetadataFields
          kind={plan.kind}
          form={meta}
          onChange={setMeta}
          issueOf={issueOf}
        />
        {confirm?.kind === "popular" ? (
          <Alert variant="warning" role="note">
            <AlertDescription>
              <p>
                Saving makes {meta.name || plan.name} Popular. {confirm.from}{" "}
                loses the Popular badge.
              </p>
              <div className="mt-2 flex gap-2">
                <Button
                  type="button"
                  loading={pending}
                  loadingLabel="Moving the badge"
                  onClick={() => void sendMeta()}
                >
                  Move the badge
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setConfirm(null)}
                >
                  Cancel
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : (
          <div>
            <Button type="submit" variant="secondary" disabled={pending}>
              Save display settings
            </Button>
          </div>
        )}
      </form>

      {plan.kind === "contact" ? null : (
        <form
          aria-label={`Terms of ${plan.name}`}
          onSubmit={saveTerms}
          className="flex flex-col gap-4"
        >
          <h4 className="font-medium">Terms</h4>
          <p className="text-sm text-muted-foreground">
            Saving a change of the limits, the key mode, the models or the
            prices creates a new version. The old version stays as it was for
            the workspaces that bought it.
          </p>
          <TermsFields
            kind={plan.kind}
            form={terms}
            onChange={setTerms}
            catalog={view.catalog}
            issueOf={issueOf}
          />
          {confirm?.kind === "terms" ? (
            <Alert variant="warning" role="note">
              <AlertDescription>
                <p>{termsSentence(confirm.terms)}</p>
                <div className="mt-2 flex gap-2">
                  <Button
                    type="button"
                    loading={pending}
                    loadingLabel="Creating the version"
                    onClick={() => void confirmTerms(confirm.terms)}
                  >
                    Create version {nextNumber}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setConfirm(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          ) : (
            <div>
              <Button type="submit" variant="secondary" disabled={pending}>
                Save as a new version
              </Button>
            </div>
          )}
        </form>
      )}

      {plan.kind === "paid" && current !== undefined ? (
        <>
          <PlanPriceCreate
            plan={plan}
            version={current}
            api={api}
            onDone={onDone}
          />
          <PlanPrices plan={plan} version={current} api={api} onDone={onDone} />
        </>
      ) : null}

      {plan.kind === "free" ? null : (
        <div className="flex flex-wrap gap-3 border-t pt-4">
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() =>
              void send(changeOf({ archived: !plan.archived }), () =>
                plan.archived
                  ? `${plan.name} is restored. It is not offered until you switch Offered on.`
                  : `${plan.name} is archived: it is hidden from new subscribers.`,
              )
            }
          >
            {plan.archived ? `Restore ${plan.name}` : `Archive ${plan.name}`}
          </Button>
          {plan.kind === "contact" ? (
            confirm?.kind === "delete" ? (
              <Alert variant="warning" role="note">
                <AlertDescription>
                  <p>Delete {plan.name}? This cannot be undone.</p>
                  <div className="mt-2 flex gap-2">
                    <Button
                      type="button"
                      variant="destructive"
                      loading={pending}
                      loadingLabel="Deleting the plan"
                      onClick={() =>
                        void send(
                          api.remove(plan.planKey),
                          () => `${plan.name} is deleted.`,
                        )
                      }
                    >
                      Delete the plan
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => setConfirm(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            ) : (
              <Button
                type="button"
                variant="destructive"
                disabled={pending}
                onClick={() => setConfirm({ kind: "delete" })}
              >
                Delete {plan.name}
              </Button>
            )
          ) : null}
        </div>
      )}
    </div>
  );
}
