// SPDX-License-Identifier: Apache-2.0

"use client";
// The suggested models of the chosen provider as a list to pick from, under a model field (#532). The field's
// `<datalist>` stays (it completes while typing), but it is the browser that decides whether and how it shows
// suggestions, so a person could find a provider with nothing to pick from. This list is always there. A pick
// fills the field; the field stays free text, so any model the provider has can still be typed.
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.tsx";

export function SuggestedModelsSelect({
  label,
  models,
  onPick,
}: {
  /** The visible placeholder and the accessible name of the list: one text, so the name contains what is seen. */
  label: string;
  models: readonly string[];
  onPick: (model: string) => void;
}) {
  if (models.length === 0) return null;
  // Always empty: it is a menu of values to put into the field, not a second place that holds the value.
  // `contain: inline-size` keeps the text from setting the width of the card (a fieldset is as wide as its widest
  // content), so a long text wraps on a narrow window instead of scrolling the page sideways.
  return (
    <Select value="" onValueChange={onPick}>
      <SelectTrigger
        aria-label={label}
        className="w-full min-w-0 text-left whitespace-normal [contain:inline-size] data-[size=default]:h-auto data-[size=default]:min-h-9"
      >
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {models.map((model) => (
          <SelectItem key={model} value={model}>
            {model}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
