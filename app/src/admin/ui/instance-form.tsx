// SPDX-License-Identifier: Apache-2.0

"use client";
// The instance settings of the portal (#181): the tenancy and the workspace limit as two cards of one
// form, with one explicit save named after what it saves ("Save instance settings") and the saved state
// inline next to each card. The tenancy copy is shared with the first-run wizard
// (`signup/ui/tenancy-copy.ts`); the rules are the server's (src/admin/tenancy.ts and
// src/admin/service.ts). A save sends only the settings that changed, runs all of them (a refusal of one
// card never drops the other change), shows each card's own result or error, and moves focus to the
// first invalid control (rulebook R20).
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../components/button.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import {
  RadioGroup,
  RadioGroupItem,
} from "../../components/ui/radio-group.tsx";
import { cn } from "../../lib/utils";
import {
  TENANCY_OPTIONS,
  type TenancyKind,
} from "../../signup/ui/tenancy-copy.ts";
import type { AdminSettingsView } from "../service.ts";
import type { AdminApi, SettingChange } from "./api.ts";
import { useFocusFirstError } from "./focus-first-error.tsx";
import { LastChanged } from "./last-changed.tsx";
import { describeAdminIssue } from "./messages.ts";
import { SaveResult, useSave, type SaveStatus } from "./use-save.tsx";

function isTenancy(value: string): value is TenancyKind {
  return value === "single" || value === "multi";
}

function workspaces(count: number): string {
  return `${String(count)} ${count === 1 ? "workspace" : "workspaces"}`;
}

export function InstanceForm({
  settings,
  api,
}: {
  settings: AdminSettingsView;
  /** Only tests pass this. */
  api?: AdminApi;
}) {
  const ids = useId();
  const tenancyHeadingId = `${ids}-tenancy-heading`;
  const limitsHeadingId = `${ids}-limits-heading`;
  const [tenancy, setTenancy] = useState<TenancyKind>(settings.tenancy.value);
  const [limitText, setLimitText] = useState(
    String(settings.maxWorkspacesPerUser.value),
  );
  const [results, setResults] = useState<{
    tenancy: SaveStatus;
    limits: SaveStatus;
  }>({ tenancy: null, limits: null });
  const { pending, save } = useSave(api, settings.workspaceCount);
  const focusTargetRef = useFocusFirstError();

  async function submit(event: FormEvent) {
    event.preventDefault();
    // Only what changed is sent, so a save does not touch the other setting's "last changed".
    const wanted: Array<"tenancy" | "limits"> = [];
    const changes: SettingChange[] = [];
    if (tenancy !== settings.tenancy.value) {
      wanted.push("tenancy");
      changes.push({ tenancy });
    }
    if (limitText !== String(settings.maxWorkspacesPerUser.value)) {
      wanted.push("limits");
      changes.push({ limits: { maxWorkspacesPerUser: Number(limitText) } });
    }
    const outcomes = await save(...changes);
    const next: typeof results = { tenancy: null, limits: null };
    wanted.forEach((key, index) => {
      next[key] = outcomes[index] ?? null;
    });
    setResults(next);
    const failed = outcomes.findIndex((outcome) => outcome.kind === "failed");
    if (failed !== -1)
      focusTargetRef.current =
        wanted[failed] === "limits" ? `${ids}-max` : `${ids}-tenancy`;
  }

  const limitIssue =
    results.limits?.kind === "failed"
      ? results.limits.issues.find(
          (issue) => issue.field === "maxWorkspacesPerUser",
        )
      : undefined;

  return (
    <form
      onSubmit={(event) => void submit(event)}
      aria-label="Instance settings"
      className="flex max-w-[44rem] flex-col gap-6"
    >
      <Card role="group" aria-labelledby={tenancyHeadingId}>
        <CardHeader>
          <CardTitle>
            <h2
              id={tenancyHeadingId}
              className="text-lg font-semibold tracking-tight"
            >
              Tenancy
            </h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <RadioGroup
            id={`${ids}-tenancy`}
            value={tenancy}
            onValueChange={(value) => {
              if (isTenancy(value)) setTenancy(value);
            }}
            aria-label="Tenancy"
            className="gap-2"
          >
            {TENANCY_OPTIONS.map((option) => {
              const optionId = `${ids}-${option.value}`;
              const selected = option.value === tenancy;
              return (
                <Field
                  key={option.value}
                  className={cn(
                    "gap-1 rounded-lg border border-border bg-card p-4 transition-colors",
                    "hover:border-ring focus-within:ring-2 focus-within:ring-ring/50",
                    selected && "border-primary bg-accent",
                  )}
                >
                  <FieldLabel
                    htmlFor={optionId}
                    className="flex w-full cursor-pointer items-start gap-3"
                  >
                    <RadioGroupItem
                      value={option.value}
                      id={optionId}
                      className="mt-0.5"
                    />
                    <span className="font-medium text-foreground">
                      {option.title}
                    </span>
                  </FieldLabel>
                  <FieldDescription className="pl-7">
                    {option.text}
                  </FieldDescription>
                </Field>
              );
            })}
          </RadioGroup>
          <FieldDescription>
            This instance has {workspaces(settings.workspaceCount)} now.
          </FieldDescription>
          <LastChanged setting={settings.tenancy} />
          <SaveResult status={results.tenancy} />
        </CardContent>
      </Card>

      <Card role="group" aria-labelledby={limitsHeadingId}>
        <CardHeader>
          <CardTitle>
            <h2
              id={limitsHeadingId}
              className="text-lg font-semibold tracking-tight"
            >
              Limits
            </h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor={`${ids}-max`}>
              Maximum number of workspaces one user may own
            </FieldLabel>
            <Input
              id={`${ids}-max`}
              inputMode="numeric"
              value={limitText}
              onChange={(event) => setLimitText(event.target.value)}
              aria-invalid={limitIssue !== undefined}
              aria-describedby={`${ids}-max-hint`}
            />
            <FieldDescription id={`${ids}-max-hint`}>
              The default is 10. It limits the workspaces a user creates in a
              multi-tenant instance.
            </FieldDescription>
            {limitIssue ? (
              <FieldError>{describeAdminIssue(limitIssue)}</FieldError>
            ) : null}
          </Field>
          <LastChanged setting={settings.maxWorkspacesPerUser} />
          <SaveResult status={results.limits} />
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={pending} loadingLabel="Saving">
          Save instance settings
        </Button>
      </div>
    </form>
  );
}
