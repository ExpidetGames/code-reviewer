// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The price of one catalog model (#554): what it is today (models.dev plus the override file), what an admin confirmed
// (and, for a stale price, how it differs), and the two ways to move on: confirm the price exactly as shown, or state the
// price (a correction with a reason). The confirmation carries the hash of the price the admin saw, so a price that moved
// meanwhile is refused (`price_changed`) and the page reloads with a notice instead of confirming what nobody looked at.
// Amounts are typed as dollars per million tokens and sent as whole micro-USD (price-form.ts), never through a float. A
// refusal is a stable code that messages.ts turns into a sentence next to the field it names.
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../components/button.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.tsx";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../../components/ui/field.tsx";
import { Checkbox } from "../../components/ui/checkbox.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import type { CatalogModelView } from "../../model-prices/admin-view.ts";
import type { RequestResult } from "../../ui/json-request.ts";
import { useFocusFirstError } from "../ui/focus-first-error.tsx";
import type { CatalogModelsApi } from "./api.ts";
import { truncateText } from "./format.ts";
import {
  PRICE_FIELD_LABEL,
  PRICE_STATUS_HELP,
  PRICE_STATUS_LABEL,
  PRICE_WARNING_COPY,
  describeCatalogError,
  describeChangedFields,
  describeIssue,
  canRetry,
  mustReload,
} from "./messages.ts";
import {
  LEVEL_FIELDS,
  PRICE_FORM_MAX_TIERS,
  bookFromForm,
  emptyLevelForm,
  formFromBook,
  hasFreeAmount,
  type LevelField,
  type LevelForm,
  type PriceForm,
  type PriceFormIssue,
} from "./price-form.ts";
import { changedPriceFields } from "./price-diff.ts";
import { PriceTable } from "./price-table.tsx";
import { STATUS_BADGE } from "./status-badges.ts";

type Outcome =
  | { kind: "saved"; text: string }
  | { kind: "failed"; code: string; retry: (() => void) | null };

const FIELD_NAME: Record<LevelField, string> = {
  input: PRICE_FIELD_LABEL.input,
  output: PRICE_FIELD_LABEL.output,
  cacheRead: PRICE_FIELD_LABEL.cacheRead,
  cacheWrite5m: PRICE_FIELD_LABEL.cacheWrite5m,
  cacheWrite1h: PRICE_FIELD_LABEL.cacheWrite1h,
  reasoning: PRICE_FIELD_LABEL.reasoning,
  inputAudio: PRICE_FIELD_LABEL.inputAudio,
  outputAudio: PRICE_FIELD_LABEL.outputAudio,
};

export function PriceDialog({
  model,
  open,
  onOpenChange,
  api,
  onChanged,
}: {
  model: CatalogModelView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  api: CatalogModelsApi;
  /** Called after a change, and after a refusal that says the page is out of date: the page reloads its data. */
  onChanged: () => void;
}) {
  const ids = useId();
  const { price } = model;
  const reference = price.reference;
  const ofModel = { providerId: model.providerId, modelId: model.modelId };
  // A form for the price as it is today: it starts again when the price moves.
  const [correcting, setCorrecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const name = truncateText(model.name, 80);

  /** Runs one call, shows its result, and reloads the page's data after a success or a refusal that says it is out of date. */
  async function run(
    call: () => Promise<RequestResult<unknown>>,
    done: string,
  ): Promise<boolean> {
    setBusy(true);
    setOutcome(null);
    const result = await call();
    setBusy(false);
    if (result.ok) {
      setOutcome({ kind: "saved", text: done });
      setCorrecting(false);
      onChanged();
      return true;
    }
    setOutcome({
      kind: "failed",
      code: result.code,
      retry: canRetry(result.code) ? () => void run(call, done) : null,
    });
    if (mustReload(result.code)) onChanged();
    return false;
  }

  const confirm = () =>
    run(() => api.confirmPrice(ofModel, reference.hash), "Price confirmed.");

  const confirmed = price.status === "confirmed";
  const hasConfirmation = price.confirmation !== null;
  // A stale price: what the confirmed price (`price.book`) differs in from the price now.
  const confirmedBook = price.status === "stale" ? price.book : null;
  const stale = confirmedBook !== null;
  const changed = stale
    ? changedPriceFields(confirmedBook, reference.book)
    : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{`Price of ${name.text}`}</DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={STATUS_BADGE[price.status]}>
                {PRICE_STATUS_LABEL[price.status]}
              </Badge>
              <span>{PRICE_STATUS_HELP[price.status]}</span>
            </div>
          </DialogDescription>
        </DialogHeader>

        {price.warnings.map((warning) => (
          <Alert key={warning} variant="warning">
            <AlertDescription>{PRICE_WARNING_COPY[warning]}</AlertDescription>
          </Alert>
        ))}

        {stale ? (
          <p className="text-sm font-medium">
            {reference.book === null
              ? "models.dev states no price now."
              : changed.length === 0
                ? "No amount differs from your confirmation: it is stale for another reason (the price format or a source changed). Confirm it again to renew it."
                : `Differs from your confirmation in: ${describeChangedFields(changed)}.`}
          </p>
        ) : null}

        {confirmed && price.book !== null ? (
          // What the managed key prices from: the confirmed book, which a correction may have made different from the catalog.
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Confirmed price</h3>
            <PriceTable
              book={price.book}
              sources={price.sources}
              label="Confirmed price"
            />
          </section>
        ) : (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">
              {hasConfirmation ? "Price now (to confirm)" : "Price to confirm"}
            </h3>
            {reference.book === null ? (
              <p className="text-sm text-muted-foreground">
                models.dev states no price we can read for this model.
              </p>
            ) : (
              <PriceTable
                book={reference.book}
                sources={reference.sources}
                label="Price now"
                changed={changed}
              />
            )}
          </section>
        )}

        {confirmed &&
        price.confirmation?.source === "admin" &&
        reference.book !== null ? (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">
              Catalog price today (not what the managed key uses)
            </h3>
            <PriceTable
              book={reference.book}
              sources={reference.sources}
              label="Catalog price today"
            />
          </section>
        ) : null}

        {hasConfirmation && !confirmed && price.book !== null ? (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">
              Price you confirmed before (no longer current)
            </h3>
            <PriceTable
              book={price.book}
              sources={price.sources}
              label="Price confirmed before"
              changed={changed}
            />
          </section>
        ) : null}

        {outcome?.kind === "saved" ? (
          <p role="status" className="text-sm text-success">
            {outcome.text}
          </p>
        ) : null}
        {outcome?.kind === "failed" ? (
          <Alert variant="destructive">
            <AlertDescription className="flex flex-wrap items-center gap-3">
              <span>{describeCatalogError(outcome.code)}</span>
              {outcome.retry === null ? null : (
                <Button variant="secondary" size="sm" onClick={outcome.retry}>
                  Try again
                </Button>
              )}
            </AlertDescription>
          </Alert>
        ) : null}

        {correcting ? (
          <CorrectionForm
            // A price that moved starts the form again, from the new price.
            key={reference.hash}
            ids={ids}
            model={model}
            busy={busy}
            onCancel={() => setCorrecting(false)}
            onSubmit={(book, reason) =>
              run(
                () => api.correctPrice(ofModel, reference.hash, book, reason),
                "Price corrected and confirmed.",
              )
            }
            serverIssue={outcome?.kind === "failed" ? outcome.code : null}
          />
        ) : (
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button variant="secondary" onClick={() => setCorrecting(true)}>
              Correct price
            </Button>
            <Button
              loading={busy}
              loadingLabel="Confirming"
              disabled={confirmed || reference.book === null}
              onClick={() => void confirm()}
            >
              Confirm price as shown
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CorrectionForm({
  ids,
  model,
  busy,
  onCancel,
  onSubmit,
  serverIssue,
}: {
  ids: string;
  model: CatalogModelView;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (
    book: Parameters<CatalogModelsApi["correctPrice"]>[2],
    reason: string,
  ) => Promise<boolean>;
  serverIssue: string | null;
}) {
  const start = model.price.reference.book ?? model.price.book;
  const [form, setForm] = useState<PriceForm>(() => formFromBook(start));
  const [issues, setIssues] = useState<PriceFormIssue[]>([]);
  const focusRef = useFocusFirstError();

  const issueOf = (field: string) => issues.find((i) => i.field === field);
  const controlId = (field: string) => `${ids}-${field.replaceAll(".", "-")}`;
  const errorOf = (field: string) => {
    const issue = issueOf(field);
    return issue === undefined ? null : (
      <FieldError id={`${controlId(field)}-error`}>
        {describeIssue(issue.code)}
      </FieldError>
    );
  };
  const describedBy = (field: string) =>
    issueOf(field) === undefined ? undefined : `${controlId(field)}-error`;

  function setLevel(
    target: "base" | "older" | number,
    field: LevelField | "contextOver",
    value: string,
  ) {
    setForm((current) => {
      if (target === "base") return { ...current, [field]: value };
      if (target === "older")
        return current.contextOver200k === null
          ? current
          : {
              ...current,
              contextOver200k: { ...current.contextOver200k, [field]: value },
            };
      return {
        ...current,
        tiers: current.tiers.map((tier, index) =>
          index === target ? { ...tier, [field]: value } : tier,
        ),
      };
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const result = bookFromForm(form);
    if (!result.ok) {
      setIssues(result.issues);
      const first = result.issues[0];
      if (first !== undefined) focusRef.current = controlId(first.field);
      return;
    }
    setIssues([]);
    void onSubmit(result.price, result.reason);
  }

  function levelFields(
    target: "base" | "older" | number,
    values: LevelForm,
    prefix: string,
    /** Tells the fields of two levels apart for a screen reader: "over 200k tokens", "tier 2". */
    where = "",
  ) {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        {LEVEL_FIELDS.map((field) => {
          const path = `${prefix}${field}`;
          const required = field === "input" || field === "output";
          return (
            <Field key={path} data-invalid={issueOf(path) !== undefined}>
              <FieldLabel htmlFor={controlId(path)}>
                {`${FIELD_NAME[field]} (USD per million tokens)${where === "" ? "" : ` – ${where}`}`}
              </FieldLabel>
              <Input
                id={controlId(path)}
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                value={values[field]}
                required={required}
                placeholder={required ? "" : "not priced"}
                aria-invalid={issueOf(path) !== undefined}
                aria-describedby={describedBy(path)}
                onChange={(event) =>
                  setLevel(target, field, event.target.value)
                }
              />
              {errorOf(path)}
            </Field>
          );
        })}
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="Correct the price"
      className="flex flex-col gap-4 border-t border-border pt-4"
    >
      <p className="text-sm text-muted-foreground">
        State the whole price in dollars per million tokens, as a number with a
        point (for example 2.5). Leave a field empty to leave it unpriced: that
        is not zero. A correction replaces the whole price and is written to the
        server log with your account.
      </p>
      {levelFields("base", form, "")}

      {form.contextOver200k === null ? (
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setForm({ ...form, contextOver200k: emptyLevelForm() })
            }
          >
            Add the older price over 200k tokens
          </Button>
        </div>
      ) : (
        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-semibold">
            {PRICE_FIELD_LABEL.contextOver200k}
          </legend>
          {levelFields(
            "older",
            form.contextOver200k,
            "contextOver200k.",
            "over 200k tokens",
          )}
          <div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setForm({ ...form, contextOver200k: null })}
            >
              Remove the price over 200k tokens
            </Button>
          </div>
        </fieldset>
      )}

      {form.tiers.map((tier, index) => (
        <fieldset key={index} className="flex flex-col gap-3">
          <legend className="text-sm font-semibold">{`Tier ${String(index + 1)}`}</legend>
          <Field
            data-invalid={
              issueOf(`tiers.${String(index)}.contextOver`) !== undefined
            }
          >
            <FieldLabel
              htmlFor={controlId(`tiers.${String(index)}.contextOver`)}
            >
              {`Applies above this many tokens – tier ${String(index + 1)}`}
            </FieldLabel>
            <Input
              id={controlId(`tiers.${String(index)}.contextOver`)}
              inputMode="numeric"
              autoComplete="off"
              className="font-mono"
              value={tier.contextOver}
              aria-invalid={
                issueOf(`tiers.${String(index)}.contextOver`) !== undefined
              }
              aria-describedby={describedBy(
                `tiers.${String(index)}.contextOver`,
              )}
              onChange={(event) =>
                setLevel(index, "contextOver", event.target.value)
              }
            />
            {errorOf(`tiers.${String(index)}.contextOver`)}
          </Field>
          {levelFields(
            index,
            tier,
            `tiers.${String(index)}.`,
            `tier ${String(index + 1)}`,
          )}
          <div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setForm({
                  ...form,
                  tiers: form.tiers.filter((_, i) => i !== index),
                })
              }
            >
              {`Remove tier ${String(index + 1)}`}
            </Button>
          </div>
        </fieldset>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          disabled={form.tiers.length >= PRICE_FORM_MAX_TIERS}
          onClick={() =>
            setForm({
              ...form,
              tiers: [...form.tiers, { ...emptyLevelForm(), contextOver: "" }],
            })
          }
        >
          Add a context tier
        </Button>
        {errorOf("tiers")}
      </div>

      {hasFreeAmount(form) ? (
        <Field data-invalid={issueOf("freeConfirmed") !== undefined}>
          <span className="flex items-start gap-2">
            <Checkbox
              id={controlId("freeConfirmed")}
              checked={form.freeConfirmed}
              aria-invalid={issueOf("freeConfirmed") !== undefined}
              aria-describedby={describedBy("freeConfirmed")}
              onCheckedChange={(checked) =>
                setForm({ ...form, freeConfirmed: checked === true })
              }
            />
            <Label htmlFor={controlId("freeConfirmed")} className="font-normal">
              The model is free: I mean 0 for input or output
            </Label>
          </span>
          {errorOf("freeConfirmed")}
        </Field>
      ) : null}

      <Field
        data-invalid={
          issueOf("reason") !== undefined || serverIssue === "reason_invalid"
        }
      >
        <FieldLabel htmlFor={controlId("reason")}>Reason</FieldLabel>
        <Input
          id={controlId("reason")}
          autoComplete="off"
          maxLength={500}
          value={form.reason}
          required
          aria-invalid={issueOf("reason") !== undefined}
          aria-describedby={[describedBy("reason"), `${ids}-reason-hint`]
            .filter(Boolean)
            .join(" ")}
          onChange={(event) => setForm({ ...form, reason: event.target.value })}
        />
        <FieldDescription id={`${ids}-reason-hint`}>
          Why the price differs from the catalog: an invoice, a price page. One
          line, written to the log.
        </FieldDescription>
        {errorOf("reason")}
      </Field>

      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={busy} loadingLabel="Saving">
          Save corrected price
        </Button>
      </DialogFooter>
    </form>
  );
}
