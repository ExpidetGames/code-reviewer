// SPDX-License-Identifier: LicenseRef-Proprietary

// The words of the billing review page (#603): what each outcome means for the operator, what the object of a row is called,
// and what "Check payment" found. The outcomes are the codes of `BILLING_REVIEW_OUTCOMES`; an unknown one is shown as its code.
import type { ReviewSubjectKind } from "./billing-review-view.ts";

const OUTCOME_COPY: Record<string, { title: string; reading: string }> = {
  amount_rejected: {
    title: "Refused: the amount does not fit",
    reading:
      "A payment, refund or dispute was refused because its amount, currency or total does not match what we asked for or credited (a discount, another currency, a refund above the credit). Nothing was credited or debited.",
  },
  intent_unresolved: {
    title: "No top-up of ours",
    reading:
      "The event is about a payment, refund or dispute that belongs to no top-up of this instance, or whose top-up could not be found. It may belong to another product on the same Stripe account, or a payment may have been taken and not credited to anybody. Nothing was changed.",
  },
  amount_conflict: {
    title: "Conflicting payment",
    reading:
      "A payment arrived for a top-up that is credited already, or with another amount than the credit it made. Nothing was changed; the buyer may have paid twice.",
  },
  workspace_deleted: {
    title: "Paid after the workspace was deleted",
    reading:
      "A payment arrived for a top-up of a workspace that was deleted in the meantime (a delayed payment method can succeed days after the checkout began). Nothing was credited. Refund the payment at Stripe.",
  },
  event_invalid: {
    title: "Event not readable",
    reading:
      "Stripe sent a signed event that the application could not read as a payment, refund or dispute. Nothing was changed.",
  },
};

export function describeOutcome(outcome: string): {
  title: string;
  reading: string;
} {
  return (
    (Object.hasOwn(OUTCOME_COPY, outcome)
      ? OUTCOME_COPY[outcome]
      : undefined) ?? {
      title: outcome,
      reading: "The application recorded this event for review.",
    }
  );
}

const SUBJECT_LABEL: Record<ReviewSubjectKind, string> = {
  payment: "Payment",
  refund: "Refund",
  dispute: "Dispute",
};

export function describeSubject(subject: {
  kind: ReviewSubjectKind;
  ref: string;
}): string {
  return `${SUBJECT_LABEL[subject.kind]} ${subject.ref}`;
}
