// SPDX-License-Identifier: Apache-2.0

"use client";
// The invoices of the workspace (#659), for an Owner and an Admin: one row per invoice the payment provider issued for a top-up,
// newest first, with its date, number, amount, status and two links, to read it and to keep the PDF. The invoices stay at the
// provider; this card asks the workspace's own route when it appears, and again when the balance changes (a payment that has just
// been confirmed leaves an invoice). Loading, empty and failed are each one short line.
import {
  DownloadSimpleIcon,
  ArrowSquareOutIcon,
} from "@phosphor-icons/react/dist/ssr";
import { useEffect, useId, useState } from "react";
import { Button } from "../../components/button.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx";
import { formatUtc } from "../../ui/format-time.ts";
import type { WorkspaceBillingApi } from "../api.ts";
import {
  INVOICE_DOWNLOAD_LINK,
  INVOICE_STATUS_LABEL,
  INVOICE_VIEW_LINK,
  INVOICES_EMPTY,
  INVOICES_FAILED,
  INVOICES_HEADING,
  INVOICES_LOADING,
  INVOICES_RETRY_BUTTON,
} from "../messages.ts";
import { formatInvoiceAmount } from "../money.ts";
import type { InvoiceStatus, InvoiceView } from "../view.ts";

const STATUS_TONE: Record<
  InvoiceStatus,
  "success" | "warning" | "neutral" | "danger"
> = {
  paid: "success",
  open: "warning",
  void: "neutral",
  uncollectible: "danger",
};

type State =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; invoices: InvoiceView[] };

function InvoiceRow({ invoice }: { invoice: InvoiceView }) {
  const name = invoice.number ?? "invoice";
  return (
    <TableRow data-invoice-id={invoice.id}>
      <TableCell className="align-top whitespace-normal text-xs text-muted-foreground">
        <time dateTime={invoice.createdAt}>{formatUtc(invoice.createdAt)}</time>
        {invoice.number === null ? null : (
          <span className="mt-1 block">{invoice.number}</span>
        )}
      </TableCell>
      <TableCell className="align-top whitespace-normal tabular-nums">
        {formatInvoiceAmount(invoice.amountMinor, invoice.currency)}
      </TableCell>
      <TableCell className="align-top whitespace-normal">
        <Badge variant={STATUS_TONE[invoice.status]}>
          {INVOICE_STATUS_LABEL[invoice.status]}
        </Badge>
      </TableCell>
      <TableCell className="align-top whitespace-normal">
        <span className="flex flex-wrap justify-end gap-x-4 gap-y-1 text-sm">
          {invoice.viewUrl === null ? null : (
            <a
              href={invoice.viewUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${INVOICE_VIEW_LINK} ${name}`}
              className="inline-flex items-center gap-1"
            >
              {INVOICE_VIEW_LINK}
              <ArrowSquareOutIcon aria-hidden="true" className="size-4" />
            </a>
          )}
          {invoice.downloadUrl === null ? null : (
            <a
              href={invoice.downloadUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${INVOICE_DOWNLOAD_LINK} ${name}`}
              className="inline-flex items-center gap-1"
            >
              {INVOICE_DOWNLOAD_LINK}
              <DownloadSimpleIcon aria-hidden="true" className="size-4" />
            </a>
          )}
        </span>
      </TableCell>
    </TableRow>
  );
}

export function InvoicesCard({
  api,
  refreshKey,
}: {
  api: WorkspaceBillingApi;
  /** A value that changes when a payment may have left an invoice (the balance): the card asks again. */
  refreshKey: number;
}) {
  const id = useId();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    void api.invoices().then((result) => {
      if (!current) return;
      setState(
        result.ok
          ? { kind: "ready", invoices: result.data.invoices }
          : { kind: "failed" },
      );
    });
    return () => {
      current = false;
    };
  }, [api, refreshKey, attempt]);

  return (
    <Card role="region" aria-labelledby={id}>
      <CardHeader>
        <CardTitle>
          <h2
            id={id}
            className="text-lg leading-7 font-semibold tracking-normal"
          >
            {INVOICES_HEADING}
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {state.kind === "loading" ? (
          <p role="status" className="text-sm text-muted-foreground">
            {INVOICES_LOADING}
          </p>
        ) : null}
        {state.kind === "failed" ? (
          <>
            <p role="alert" className="text-sm text-destructive">
              {INVOICES_FAILED}
            </p>
            <div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setState({ kind: "loading" });
                  setAttempt((value) => value + 1);
                }}
              >
                {INVOICES_RETRY_BUTTON}
              </Button>
            </div>
          </>
        ) : null}
        {state.kind === "ready" && state.invoices.length === 0 ? (
          <p className="text-sm text-muted-foreground">{INVOICES_EMPTY}</p>
        ) : null}
        {state.kind === "ready" && state.invoices.length > 0 ? (
          <Table aria-label={INVOICES_HEADING}>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[30%]">Date</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Links</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.invoices.map((invoice) => (
                <InvoiceRow key={invoice.id} invoice={invoice} />
              ))}
            </TableBody>
          </Table>
        ) : null}
      </CardContent>
    </Card>
  );
}
