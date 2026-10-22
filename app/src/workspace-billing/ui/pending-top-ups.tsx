// SPDX-License-Identifier: Apache-2.0

"use client";
// A payment that was started and has not been confirmed (ADR 0006, 2.13; #505): the amount, when it was started and, where the
// provider can be asked, "Check payment". The check asks the provider what became of the payment and applies the answer once,
// exactly as a webhook would have, so it repairs a webhook that was lost; the balance rises at most once, however often it is asked.
import { useId } from "react";
import { Button } from "../../components/button.tsx";
import { StatusRegion } from "../../components/status-region.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import { formatUtc } from "../../ui/format-time.ts";
import type { WorkspaceBillingApi } from "../api.ts";
import {
  CHECK_PAYMENT_BUTTON,
  CHECK_PAYMENT_LOADING,
  CHECK_RESULT,
  describeBillingFailure,
  PENDING_EXPLAINER,
  PENDING_HEADING,
} from "../messages.ts";
import { formatMoney } from "../money.ts";
import type { PendingTopUpView } from "../view.ts";
import { useAction } from "./use-action.ts";

function PendingRow({
  item,
  api,
}: {
  item: PendingTopUpView;
  api: WorkspaceBillingApi;
}) {
  const { pending, outcome, run } = useAction();
  function check() {
    void run("check", async () => {
      const result = await api.checkPayment(item.id);
      if (!result.ok)
        return {
          kind: "failed",
          text: describeBillingFailure(result.code),
          issues: [],
        };
      return {
        kind: "ok",
        text: CHECK_RESULT[result.data.state] ?? CHECK_RESULT.pending ?? "",
      };
    });
  }
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2">
      <span className="font-semibold tabular-nums">
        {formatMoney(item.amountMicroUsd)}
      </span>
      <span className="text-xs text-muted-foreground">
        Started{" "}
        <time dateTime={item.createdAt}>{formatUtc(item.createdAt)}</time>
      </span>
      {item.canCheck ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={check}
          loading={pending === "check"}
          loadingLabel={CHECK_PAYMENT_LOADING}
        >
          {CHECK_PAYMENT_BUTTON}
        </Button>
      ) : null}
      <StatusRegion>{outcome === null ? null : outcome.text}</StatusRegion>
    </li>
  );
}

export function PendingTopUps({
  items,
  api,
}: {
  items: PendingTopUpView[];
  api: WorkspaceBillingApi;
}) {
  const id = useId();
  if (items.length === 0) return null;
  return (
    <Card role="region" aria-labelledby={id}>
      <CardHeader>
        <CardTitle>
          <h2 id={id} className="text-lg font-semibold tracking-tight">
            {PENDING_HEADING}
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">{PENDING_EXPLAINER}</p>
        <ul className="divide-y divide-border">
          {items.map((item) => (
            <PendingRow key={item.id} item={item} api={api} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
