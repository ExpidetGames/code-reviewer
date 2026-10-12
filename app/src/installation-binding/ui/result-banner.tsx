// SPDX-License-Identifier: Apache-2.0

// The banner of the GitHub result page: what a connect flow ended with, in words, in the alert tone
// that matches the outcome. An outcome that is neither a failure nor a success is information and
// uses the neutral `info` tone; the page used to render the warning fallback for it (#171).
import { Alert } from "@/components/ui/alert";
import type { ResultTone } from "./messages.ts";

const ALERT_VARIANT: Record<ResultTone, "success" | "info" | "destructive"> = {
  success: "success",
  info: "info",
  error: "destructive",
};

export function ResultBanner({
  result,
}: {
  /** The outcome of the flow, or null when the code in the address names none. */
  result: { tone: ResultTone; text: string } | null;
}) {
  return (
    <Alert variant={result === null ? "default" : ALERT_VARIANT[result.tone]}>
      {result?.text ?? "Nothing was connected."}
    </Alert>
  );
}
