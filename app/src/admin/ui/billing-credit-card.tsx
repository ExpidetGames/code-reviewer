// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The manual credit and correction (#504, ADR 0006, P10): find a workspace by name, see its balance and its recent journal
// entries, and write a credit or a signed correction with a required note. It works with either adapter, and while billing is
// off. The entry is written through the manual adapter with the admin as the actor; the note and the actor stay in the
// journal. The server judges every value; the card shows the reason it gets back. A form token makes one entry however often
// the form is sent.
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
import {
  RadioGroup,
  RadioGroupItem,
} from "../../components/ui/radio-group.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { formatUtc } from "../../ui/format-time.ts";
import type { BillingApi } from "./billing-api.ts";
import { formatUsdFixed, parseUsd } from "./billing-money.ts";
import {
  describeBillingFailure,
  describeBillingIssue,
} from "./billing-messages.ts";
import { OutcomeNote, useBillingRun } from "./billing-run.tsx";
import type {
  BillingWorkspaceBalanceView,
  BillingWorkspaceView,
} from "./billing-view.ts";

type Kind = "credit" | "correction";

const ENTRY_LABEL: Record<string, string> = {
  top_up: "Top-up or credit",
  start_credit: "Start credit",
  reservation: "Hold",
  usage: "Usage",
  release: "Hold released",
  refund: "Refund",
  chargeback: "Chargeback",
  correction: "Correction",
};

function newRequestId(): string {
  return crypto.randomUUID();
}

export function BillingCreditCard({ api }: { api: BillingApi }) {
  const product = useProductIdentity();
  const ids = useId();
  const search = useBillingRun();
  const credit = useBillingRun();
  const [text, setText] = useState("");
  const [found, setFound] = useState<BillingWorkspaceView[] | null>(null);
  const [selected, setSelected] = useState<BillingWorkspaceBalanceView | null>(
    null,
  );
  const [kind, setKind] = useState<Kind>("credit");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [requestId, setRequestId] = useState(newRequestId);
  const [local, setLocal] = useState<{ amount?: string }>({});

  const issueOf = (field: string) =>
    credit.outcome?.kind === "failed"
      ? credit.outcome.issues.find((issue) => issue.field === field)
      : undefined;
  const amountIssue = issueOf("amountMicroUsd");
  const noteIssue = issueOf("note");

  function lookUp(event: FormEvent) {
    event.preventDefault();
    void search.run("search", async () => {
      const result = await api.searchWorkspaces(text);
      if (!result.ok)
        return {
          kind: "failed",
          text: describeBillingFailure(product, result.code, result.status),
          issues: [],
          missing: [],
        };
      setFound(result.data.workspaces);
      return null;
    });
  }

  function choose(workspace: BillingWorkspaceView) {
    void search.run("choose", async () => {
      const result = await api.workspace(workspace.id);
      if (!result.ok)
        return {
          kind: "failed",
          text: describeBillingFailure(product, result.code, result.status),
          issues: [],
          missing: [],
        };
      setSelected(result.data);
      credit.clear();
      return null;
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (selected === null) return;
    const micro = parseUsd(amount, { signed: kind === "correction" });
    if (micro === null) {
      setLocal({
        amount: describeBillingIssue({
          field: "amountMicroUsd",
          code: "amount_invalid",
        }),
      });
      return;
    }
    setLocal({});
    void credit.run("credit", async () => {
      const result = await api.credit(selected.workspace.id, {
        type: kind,
        amountMicroUsd: micro,
        note,
        requestId,
      });
      if (!result.ok)
        return {
          kind: "failed",
          text: describeBillingFailure(product, result.code, result.status),
          issues: result.issues,
          missing: [],
        };
      setSelected(result.data.workspace);
      setAmount("");
      setNote("");
      // The next entry is another request.
      setRequestId(newRequestId());
      return {
        kind: "ok",
        text:
          kind === "credit"
            ? "The credit is written to the journal."
            : "The correction is written to the journal.",
      };
    });
  }

  return (
    <Card role="region" aria-labelledby={`${ids}-credit`}>
      <CardHeader>
        <CardTitle>
          <h2
            id={`${ids}-credit`}
            className="text-lg font-semibold tracking-tight"
          >
            Manual credit and correction
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <p className="text-sm text-muted-foreground">
          Credit a workspace, or correct its balance (a correction can be
          negative), with a note that says why. The entry stays in the journal
          with your name. This works with either adapter, also while billing is
          off.
        </p>

        <form
          onSubmit={lookUp}
          aria-label="Find a workspace"
          className="flex flex-wrap items-end gap-3"
        >
          <Field className="min-w-60 flex-1">
            <FieldLabel htmlFor={`${ids}-search`}>Search workspaces</FieldLabel>
            <Input
              id={`${ids}-search`}
              value={text}
              autoComplete="off"
              onChange={(event) => setText(event.target.value)}
            />
          </Field>
          <Button
            type="submit"
            variant="secondary"
            loading={search.pending === "search"}
            loadingLabel="Searching workspaces"
          >
            Search
          </Button>
        </form>
        <OutcomeNote outcome={search.outcome} />
        {found === null ? null : found.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No workspace has that in its name.
          </p>
        ) : (
          <ul aria-label="Workspaces found" className="flex flex-col gap-1">
            {found.map((workspace) => (
              <li key={workspace.id}>
                <Button
                  variant="ghost"
                  onClick={() => choose(workspace)}
                  aria-pressed={selected?.workspace.id === workspace.id}
                >
                  {workspace.name}{" "}
                  <span className="text-muted-foreground">
                    ({workspace.slug})
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        )}

        {selected === null ? null : (
          <>
            <div
              className="flex flex-col gap-1 text-sm"
              role="group"
              aria-label={`Balance of ${selected.workspace.name}`}
            >
              <p>
                <strong>{selected.workspace.name}</strong> has a balance of{" "}
                <strong>{formatUsdFixed(selected.balanceMicroUsd)} USD</strong>
                {selected.reservedMicroUsd > 0
                  ? ` (${formatUsdFixed(selected.reservedMicroUsd)} USD is held by running reviews)`
                  : ""}
                .
              </p>
            </div>
            {selected.entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                The journal of this workspace has no entry yet.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Entry</TableHead>
                    <TableHead className="text-right">USD</TableHead>
                    <TableHead>Note</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {selected.entries.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell>{formatUtc(entry.createdAt)}</TableCell>
                      <TableCell>
                        {ENTRY_LABEL[entry.type] ?? entry.type}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatUsdFixed(entry.amountMicroUsd)}
                      </TableCell>
                      <TableCell
                        className="max-w-64 truncate"
                        title={entry.note ?? undefined}
                      >
                        {entry.note ?? ""}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            <form
              onSubmit={submit}
              aria-label="Credit or correct the balance"
              className="flex flex-col gap-4"
            >
              <Field>
                <FieldLabel id={`${ids}-kind`}>What to write</FieldLabel>
                <RadioGroup
                  value={kind}
                  onValueChange={(value) => {
                    if (value === "credit" || value === "correction")
                      setKind(value);
                  }}
                  aria-labelledby={`${ids}-kind`}
                  className="gap-2"
                >
                  {(
                    [
                      ["credit", "A credit (adds to the balance)"],
                      ["correction", "A correction (adds or takes away)"],
                    ] as const
                  ).map(([value, label]) => (
                    <FieldLabel
                      key={value}
                      htmlFor={`${ids}-kind-${value}`}
                      className="flex cursor-pointer items-center gap-3"
                    >
                      <RadioGroupItem
                        value={value}
                        id={`${ids}-kind-${value}`}
                      />
                      <span>{label}</span>
                    </FieldLabel>
                  ))}
                </RadioGroup>
              </Field>
              <Field
                data-invalid={
                  local.amount !== undefined || amountIssue !== undefined
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
                    local.amount !== undefined || amountIssue !== undefined
                  }
                />
                <FieldDescription>
                  {kind === "credit"
                    ? "For example 10. At most 10,000 at once."
                    : "For example -2 to take 2 away. At most 10,000 at once."}
                </FieldDescription>
                {local.amount !== undefined ? (
                  <FieldError>{local.amount}</FieldError>
                ) : amountIssue === undefined ? null : (
                  <FieldError>{describeBillingIssue(amountIssue)}</FieldError>
                )}
              </Field>
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
                  Required. Why this entry is written; it is read in the journal
                  later.
                </FieldDescription>
                {noteIssue === undefined ? null : (
                  <FieldError>{describeBillingIssue(noteIssue)}</FieldError>
                )}
              </Field>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="submit"
                  loading={credit.pending === "credit"}
                  loadingLabel="Writing the entry"
                >
                  {kind === "credit" ? "Write credit" : "Write correction"}
                </Button>
              </div>
              <OutcomeNote outcome={credit.outcome} />
            </form>
          </>
        )}
      </CardContent>
    </Card>
  );
}
