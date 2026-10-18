// SPDX-License-Identifier: Apache-2.0

"use client";
// The provider select of a workspace on its own key (#433), next to the model field: one entry per registered provider
// (`src/llm/providers/`). A provider without a stored key is marked "no key yet" and can still be chosen (decision C7):
// the job then fails with `llm_not_configured`, so the form warns instead of refusing, with a link to the LLM access
// page where the key is entered. Whether a key is stored comes from the page (`keyedProviders`), never from the key.
import Link from "next/link";
import { useId } from "react";
import { Alert } from "../../components/ui/alert.tsx";
import { FieldLabel } from "../../components/ui/field.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.tsx";
import type { LlmProviderDescriptor } from "../../llm/providers/types.ts";
import { workspacePath } from "../../workspaces/paths.ts";
import type {
  ProjectDynamicSettingField,
  ReviewSettingField,
} from "../settings.ts";
import { Origin, type SettingsOrigin } from "./settings-fields.tsx";

/** What a provider select needs of a provider: the id it stores, the name people read, whether a key is stored. */
export type ProviderOption = {
  id: string;
  label: string;
  /** False: no key is stored for this provider in the workspace (or it cannot be read). */
  hasKey: boolean;
};

export const NO_KEY_MARK = "no key yet";

/**
 * The options of the select. `keyed` is the list of providers that have a stored key; unknown (`undefined`) counts as
 * keyed, so a form never warns about something it was not told.
 */
export function providerOptions(
  providers: readonly Pick<LlmProviderDescriptor, "id" | "label">[],
  keyed: readonly string[] | undefined,
): ProviderOption[] {
  return providers.map((provider) => ({
    id: provider.id,
    label: provider.label,
    hasKey: keyed === undefined || keyed.includes(provider.id),
  }));
}

export function ProviderSelect({
  workspaceSlug,
  name,
  label,
  value,
  options,
  origin,
  error,
  onChange,
}: {
  workspaceSlug: string;
  name: Extract<
    ReviewSettingField | ProjectDynamicSettingField,
    "provider" | "dynamicProvider"
  >;
  label: string;
  value: string;
  options: readonly ProviderOption[];
  origin: SettingsOrigin;
  error?: string | undefined;
  onChange: (provider: string) => void;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const chosen = options.find((option) => option.id === value);
  return (
    <div data-field={name} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Origin origin={origin} />
      </div>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger
          id={id}
          className="w-full"
          aria-invalid={error !== undefined}
          aria-describedby={error === undefined ? undefined : errorId}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.hasKey
                ? option.label
                : `${option.label} (${NO_KEY_MARK})`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error !== undefined ? (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {chosen !== undefined && !chosen.hasKey ? (
        <Alert variant="warning" role="status" data-provider-without-key="">
          <p className="col-start-1 [grid-column:1/-1]">
            No key is stored for {chosen.label} yet. Reviews that use it fail
            until a key is added on the{" "}
            <Link
              href={workspacePath(workspaceSlug, "/settings/llm")}
              className="font-medium underline underline-offset-4"
            >
              LLM access
            </Link>{" "}
            page.
          </p>
        </Alert>
      ) : null}
    </div>
  );
}
