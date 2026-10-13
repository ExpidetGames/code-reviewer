// SPDX-License-Identifier: Apache-2.0

"use client";
// The small "Copy" control of the admin's GitHub App addresses (#182 lead note, #185). It copies
// the value it is given and announces the result in one polite live region; the live region carries
// the button's `label` so the several addresses of one page are told apart. The clipboard may be
// missing (an insecure context); that is the same failure as a refused write.
import { useState } from "react";
import { Button } from "@/components/button";
import { StatusRegion } from "@/components/status-region";

export function CopyButton({
  value,
  label,
}: {
  /** The text to put on the clipboard. */
  value: string;
  /** The accessible name, for example "Copy the Webhook URL". */
  label: string;
}) {
  const [result, setResult] = useState<"copied" | "failed" | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setResult("copied");
    } catch {
      setResult("failed");
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-label={label}
        onClick={() => void copy()}
      >
        Copy
      </Button>
      <StatusRegion label={label}>
        {result === "copied"
          ? "Copied."
          : result === "failed"
            ? "Copying did not work: select the address and copy it."
            : ""}
      </StatusRegion>
    </>
  );
}
