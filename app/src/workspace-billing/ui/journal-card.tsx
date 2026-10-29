// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The journal of the workspace's money (ADR 0006, 2.5, 2.7; #505): credit added, the start credit, what each review was charged
// (its AI price and its infrastructure price and a link to the run), refunds, chargebacks and corrections, newest first, page by
// page. A hold and its release are not rows. No rate, no minute count and no formula is ever in it.
import { useProductIdentity } from "../../product-identity/context.tsx";
import Link from "next/link";
import { useId, useState } from "react";
import { Button } from "../../components/button.tsx";
import { StatusRegion } from "../../components/status-region.tsx";
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
import { workspacePath } from "../../workspaces/paths.ts";
import type { WorkspaceBillingApi } from "../api.ts";
import {
  describeBillingFailure,
  JOURNAL_EMPTY,
  JOURNAL_HEADING,
  JOURNAL_MORE_BUTTON,
  JOURNAL_MORE_LOADING,
  JOURNAL_ROW_LABEL,
} from "../messages.ts";
import { formatSignedMoney } from "../money.ts";
import type { JournalPageView, JournalRowView } from "../view.ts";
import { RunPriceText } from "./run-price.tsx";
import { useAction } from "./use-action.ts";

function JournalRow({
  row,
  workspaceSlug,
}: {
  row: JournalRowView;
  workspaceSlug: string;
}) {
  return (
    <TableRow data-entry-id={row.id}>
      <TableCell className="align-top whitespace-normal text-xs text-muted-foreground">
        <time dateTime={row.createdAt}>{formatUtc(row.createdAt)}</time>
      </TableCell>
      <TableCell className="align-top whitespace-normal">
        <span className="block">{JOURNAL_ROW_LABEL[row.kind]}</span>
        {row.kind !== "usage" ? null : (
          <span className="mt-1 flex flex-col gap-1 text-xs">
            {row.run === null ? null : (
              <Link
                href={workspacePath(
                  workspaceSlug,
                  `/runs/${encodeURIComponent(row.run.id)}`,
                )}
                className="truncate"
              >
                {row.run.label}
              </Link>
            )}
            <RunPriceText
              price={{
                state: "charged",
                aiMicroUsd: row.aiMicroUsd,
                infraMicroUsd: row.infraMicroUsd ?? 0,
              }}
            />
          </span>
        )}
      </TableCell>
      <TableCell className="text-right align-top whitespace-normal tabular-nums">
        {formatSignedMoney(row.amountMicroUsd)}
      </TableCell>
    </TableRow>
  );
}

export function JournalCard({
  workspaceSlug,
  initial,
  api,
}: {
  workspaceSlug: string;
  initial: JournalPageView;
  api: WorkspaceBillingApi;
}) {
  const product = useProductIdentity();
  const id = useId();
  const { pending, outcome, run } = useAction();
  // Older pages are fetched here; when the server renders the page again (a refresh) its first page wins and they are dropped.
  const [older, setOlder] = useState<{
    base: JournalPageView;
    rows: JournalRowView[];
    next: string | null;
  }>({ base: initial, rows: [], next: initial.next });
  const current =
    older.base === initial
      ? older
      : { base: initial, rows: [] as JournalRowView[], next: initial.next };
  const rows = [...initial.rows, ...current.rows];

  function more() {
    const cursor = current.next;
    if (cursor === null) return;
    void run(
      "more",
      async () => {
        const result = await api.journal(cursor);
        if (!result.ok)
          return {
            kind: "failed",
            text: describeBillingFailure(product, result.code),
            issues: [],
          };
        setOlder({
          base: initial,
          rows: [...current.rows, ...result.data.rows],
          next: result.data.next,
        });
        return null;
      },
      { refresh: false },
    );
  }

  return (
    <Card role="region" aria-labelledby={id}>
      <CardHeader>
        <CardTitle>
          <h2
            id={id}
            className="text-lg leading-7 font-semibold tracking-normal"
          >
            {JOURNAL_HEADING}
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{JOURNAL_EMPTY}</p>
        ) : (
          <Table aria-label={JOURNAL_HEADING}>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[26%]">When</TableHead>
                <TableHead>Entry</TableHead>
                <TableHead className="w-[20%] text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <JournalRow
                  key={row.id}
                  row={row}
                  workspaceSlug={workspaceSlug}
                />
              ))}
            </TableBody>
          </Table>
        )}
        <StatusRegion className="text-destructive">
          {outcome?.kind === "failed" ? outcome.text : null}
        </StatusRegion>
        {current.next === null ? null : (
          <div>
            <Button
              variant="secondary"
              onClick={more}
              loading={pending === "more"}
              loadingLabel={JOURNAL_MORE_LOADING}
            >
              {JOURNAL_MORE_BUTTON}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
