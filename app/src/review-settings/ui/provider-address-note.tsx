// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The address a project pinned for its catalog provider (#588, needs a security review). It is the one address the project's own
// key goes to; the catalog's address is trusted when the provider is selected, and after that only the person's confirmation
// moves it. Read-only text, plus the one action that pins the address the catalog trusts now.
import { useId } from "react";
import { Alert } from "../../components/ui/alert.tsx";
import { Checkbox } from "../../components/ui/checkbox.tsx";
import { Label } from "../../components/ui/label.tsx";
import type { ProviderAddressView } from "../provider-pin.ts";

export const ADDRESS_CHANGED_TEXT =
  "The address of this provider changed after it was selected for this project. Reviews of this project are refused and your key is not sent anywhere until an Owner or Admin of the workspace confirms the new address.";
export const ADDRESS_UNAVAILABLE_TEXT =
  "The catalog lists no usable address for this provider right now, so reviews of this project are refused. Choose another provider, or try again after the next catalog refresh.";
export const ADDRESS_UNPINNED_TEXT =
  "Your key address is fixed at the next review to the address the catalog lists now:";
export const ADDRESS_PINNED_TEXT =
  "Your key is sent only to the address fixed when this provider was selected:";
export const ADDRESS_CONFIRM_BY_ADMIN_TEXT =
  "An Owner or Admin must confirm the new address; ask one of them to open these settings.";
export const CONFIRM_ADDRESS_LABEL =
  "Confirm the new address and send my key there";

export function ProviderAddressNote({
  address,
  confirm,
  canConfirm,
  disabled,
  onConfirmChange,
}: {
  address: ProviderAddressView;
  confirm: boolean;
  /** The person may manage the workspace's LLM key (`manage_llm_key`): only they confirm a new address (#588). */
  canConfirm: boolean;
  disabled: boolean;
  onConfirmChange: (confirm: boolean) => void;
}) {
  const id = useId();
  if (address.state === "pinned")
    return (
      <p className="text-xs text-muted-foreground">
        {ADDRESS_PINNED_TEXT}{" "}
        <code className="break-all">{address.pinned}</code>
      </p>
    );
  if (address.state === "unpinned")
    return (
      <p className="text-xs text-muted-foreground">
        {ADDRESS_UNPINNED_TEXT}{" "}
        <code className="break-all">{address.current}</code>
      </p>
    );
  if (address.state === "unavailable")
    return (
      <Alert variant="warning" role="alert">
        <p>{ADDRESS_UNAVAILABLE_TEXT}</p>
        {address.pinned === null ? null : (
          <p className="text-xs">
            Fixed address: <code className="break-all">{address.pinned}</code>
          </p>
        )}
      </Alert>
    );
  return (
    <Alert variant="warning" role="alert">
      <p>{ADDRESS_CHANGED_TEXT}</p>
      <p className="text-xs">
        Fixed when selected: <code className="break-all">{address.pinned}</code>
      </p>
      <p className="text-xs">
        Listed now: <code className="break-all">{address.current}</code>
      </p>
      {canConfirm ? (
        <span className="mt-2 flex items-start gap-2">
          <Checkbox
            id={`${id}-confirm`}
            checked={confirm}
            disabled={disabled}
            onCheckedChange={(checked) => onConfirmChange(checked === true)}
          />
          <Label htmlFor={`${id}-confirm`} className="font-normal">
            {CONFIRM_ADDRESS_LABEL}
          </Label>
        </span>
      ) : (
        <p className="mt-2 text-xs">{ADDRESS_CONFIRM_BY_ADMIN_TEXT}</p>
      )}
    </Alert>
  );
}
