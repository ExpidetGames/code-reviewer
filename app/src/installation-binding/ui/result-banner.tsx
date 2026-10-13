// SPDX-License-Identifier: Apache-2.0

// The banner of the GitHub result page: what a connect flow ended with, in words, in the alert tone
// that matches the outcome. An outcome that is neither a failure nor a success is information: the
// neutral `info` tone, never the old warning fallback (#171). The banner is server-rendered static
// content, so every tone is a polite `status`, never an assertive `alert`.
import { Alert, AlertDescription } from "@/components/ui/alert";
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
  const tone = result?.tone ?? null;
  return (
    <Alert
      variant={tone === null ? "default" : ALERT_VARIANT[tone]}
      role="status"
    >
      <AlertDescription>
        {result?.text ?? "Nothing was connected."}
      </AlertDescription>
    </Alert>
  );
}
