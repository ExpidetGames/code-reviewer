// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The actions of one catalog model (#554): enable, disable, take the decision back (the model is "new" again), and open
// its price. A change is one request; the page's data is reloaded after it, and a refusal is a stable code that
// messages.ts turns into a sentence. Nothing here throws.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "../../components/button.tsx";
import { StatusRegion } from "../../components/status-region.tsx";
import type { CatalogModelView } from "../../model-prices/admin-view.ts";
import type { RequestResult } from "../../ui/json-request.ts";
import { browserCatalogModelsApi, type CatalogModelsApi } from "./api.ts";
import { truncateText } from "./format.ts";
import { describeCatalogError } from "./messages.ts";
import { PriceDialog } from "./price-dialog.tsx";

type Outcome =
  { kind: "saved"; text: string } | { kind: "failed"; text: string };

export function ModelActions({
  model,
  api = browserCatalogModelsApi,
}: {
  model: CatalogModelView;
  /** Only tests pass this. */
  api?: CatalogModelsApi;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [priceOpen, setPriceOpen] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const ids = { providerId: model.providerId, modelId: model.modelId };
  const name = truncateText(model.name, 60).text;

  async function run(
    call: () => Promise<RequestResult<unknown>>,
    done: string,
  ) {
    setBusy(true);
    setOutcome(null);
    const result = await call();
    setBusy(false);
    if (!result.ok) {
      setOutcome({ kind: "failed", text: describeCatalogError(result.code) });
      return;
    }
    setOutcome({ kind: "saved", text: done });
    router.refresh();
  }

  // The accessible name of a button contains the words it shows (WCAG 2.5.3): "Price of X", "Review price of X".
  const priceLabel =
    model.price.status === "confirmed" ? "Price" : "Review price";

  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          aria-label={`${priceLabel} of ${name}`}
          onClick={() => setPriceOpen(true)}
        >
          {priceLabel}
        </Button>
        {model.enabled === true ? null : (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            aria-label={`Enable ${name}`}
            onClick={() =>
              void run(() => api.setEnabled(ids, true), "Enabled.")
            }
          >
            Enable
          </Button>
        )}
        {model.enabled === false ? null : (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            aria-label={`Disable ${name}`}
            onClick={() =>
              void run(() => api.setEnabled(ids, false), "Disabled.")
            }
          >
            Disable
          </Button>
        )}
        {model.enabled === null ? null : (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            aria-label={`Reset to new: ${name}`}
            onClick={() =>
              void run(
                () => api.resetDecision(ids),
                "The decision is taken back.",
              )
            }
          >
            Reset to new
          </Button>
        )}
      </div>
      <StatusRegion
        label={`Result for ${name}`}
        className={outcome?.kind === "failed" ? "text-destructive" : ""}
      >
        {outcome?.text ?? ""}
      </StatusRegion>
      {priceOpen ? (
        <PriceDialog
          model={model}
          open
          onOpenChange={setPriceOpen}
          api={api}
          onChanged={() => router.refresh()}
        />
      ) : null}
    </div>
  );
}
