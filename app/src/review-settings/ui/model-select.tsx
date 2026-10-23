// SPDX-License-Identifier: Apache-2.0

"use client";
// The model dropdown of the LLM section (#656): a list to choose from, never a field to type in. It sits under the provider
// dropdown and offers the models of that provider only. The chosen value stays in the list even when the provider does not
// list it now (a saved model that was retired), so the page never shows a choice that is not the one in force.
import { useId } from "react";
import { FieldLabel } from "../../components/ui/field.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.tsx";

export type ModelOption = {
  id: string;
  label: string;
  /** Shown next to the label; the option cannot be chosen (a locked choice of the catalog). */
  note?: string;
  disabled?: boolean;
};

/** The options with the value in force added when the list does not have it, so it is never lost silently. */
export function withCurrentModel(
  options: readonly ModelOption[],
  current: string,
): ModelOption[] {
  if (current === "" || options.some((option) => option.id === current))
    return [...options];
  return [{ id: current, label: current }, ...options];
}

export function ModelSelect({
  name,
  label,
  value,
  options,
  onChange,
  error,
  disabled = false,
  placeholder = "Choose a model",
  loading = false,
}: {
  /** The setting the dropdown edits; the `data-field` of its wrapper. */
  name: string;
  label: string;
  /** The id of the chosen model; empty when none is chosen. */
  value: string;
  options: readonly ModelOption[];
  onChange: (id: string) => void;
  error?: string | undefined;
  disabled?: boolean;
  placeholder?: string;
  /** The list is still being fetched. */
  loading?: boolean;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div data-field={name} className="flex flex-col gap-2">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        value={value === "" ? undefined : value}
        onValueChange={onChange}
        disabled={disabled || loading}
      >
        <SelectTrigger
          id={id}
          className="w-full"
          aria-invalid={error !== undefined}
          aria-describedby={error === undefined ? undefined : errorId}
        >
          <SelectValue
            placeholder={loading ? "Loading the models" : placeholder}
          />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem
              key={option.id}
              value={option.id}
              disabled={option.disabled === true}
            >
              {option.label}
              {option.note === undefined ? "" : ` (${option.note})`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error !== undefined ? (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
