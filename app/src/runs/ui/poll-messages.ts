// SPDX-License-Identifier: LicenseRef-Proprietary

// What the runs pages say when a poll fails: the generic notice (the last data stays, the page keeps
// trying), and the sentence for a failure that ends polling for good.
import { NOT_AVAILABLE_TO_YOU } from "../../copy/messages.ts";
import {
  TRANSPORT_FAILURE_COPY,
  describeTransportFailure,
} from "../../ui/transport-messages.ts";

export const POLL_FAILED_TEXT =
  "Updating failed. The list shows the last data it got; it keeps trying.";
export const DETAIL_POLL_FAILED_TEXT =
  "Updating failed. This page shows the last data it got; it keeps trying.";
export const RUN_GONE_TEXT = "This run no longer exists.";

const STOPPED_SUFFIX = " This page no longer updates; reload it to try again.";

/** The sentence for a failed poll; `stopped` says polling ended (a permanent failure). */
export function describePollFailure(
  code: string | null,
  stopped: boolean,
  generic: string,
): string {
  if (!stopped || code === null) return generic;
  const sentence =
    code === "RUN_NOT_FOUND"
      ? RUN_GONE_TEXT
      : code === "not_found"
        ? NOT_AVAILABLE_TO_YOU
        : (describeTransportFailure(code) ??
          TRANSPORT_FAILURE_COPY.UNEXPECTED_RESPONSE);
  return `${sentence}${STOPPED_SUFFIX}`;
}
