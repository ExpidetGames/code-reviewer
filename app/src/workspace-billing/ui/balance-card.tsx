// SPDX-License-Identifier: Apache-2.0

// The balance of the workspace in US dollars, what running reviews hold (only while something is held), and, when reviews are
// paused for want of credit, why and what to do about it (#505, ADR 0006, 2.5). A balance above zero starts reviews, even by one
// cent; at zero and below none starts, and a review that is already running always finishes.
import { useId } from "react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../../components/ui/alert.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import { formatMoney } from "../money.ts";
import {
  BALANCE_EXPLAINER,
  BALANCE_HEADING,
  EMPTY_BALANCE,
  HELD_TEXT,
  NEGATIVE_BALANCE,
} from "../messages.ts";
import type { WorkspaceBillingView } from "../view.ts";

export function BalanceCard({ view }: { view: WorkspaceBillingView }) {
  const id = useId();
  const pause =
    view.state === "negative"
      ? NEGATIVE_BALANCE
      : view.state === "empty"
        ? EMPTY_BALANCE
        : null;
  return (
    <Card role="region" aria-labelledby={id}>
      <CardHeader>
        <CardTitle>
          <h2
            id={id}
            className="text-lg leading-7 font-semibold tracking-normal"
          >
            {BALANCE_HEADING}
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p
          className="text-3xl font-semibold tabular-nums"
          data-slot="balance-amount"
        >
          {formatMoney(view.balanceMicroUsd)}
        </p>
        {view.heldMicroUsd > 0 ? (
          <p className="text-sm text-muted-foreground">
            {HELD_TEXT}:{" "}
            <span className="tabular-nums">
              {formatMoney(view.heldMicroUsd)}
            </span>
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">{BALANCE_EXPLAINER}</p>
        {pause === null ? null : (
          <Alert
            variant={view.state === "negative" ? "destructive" : "warning"}
          >
            <AlertTitle>{pause.title}</AlertTitle>
            <AlertDescription>
              <p>{pause.body}</p>
              <p>{view.canManage ? pause.ownerAction : pause.memberAction}</p>
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
