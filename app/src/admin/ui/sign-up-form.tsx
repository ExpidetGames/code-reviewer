// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The sign-up rule (#181): everyone, a list of emails or allowed email domains, as one card with one
// form. It changes who can create an account from now on; accounts that exist are never deleted or
// locked by it. A rule that names emails or domains is shown by the page while it cannot work yet
// (`NeedsAttention` with the shared notice from `notices.tsx`), so the copy has one owner.
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
import {
  RadioGroup,
  RadioGroupItem,
} from "../../components/ui/radio-group.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { cn } from "../../lib/utils";
import {
  SIGN_UP_RULE_OPTIONS,
  type SignUpRuleKind,
} from "../../signup/ui/rule-copy.ts";
import type { AdminSettingsView } from "../service.ts";
import type { AdminApi } from "./api.ts";
import { useFocusFirstError } from "./focus-first-error.tsx";
import { LastChanged } from "./last-changed.tsx";
import { describeAdminIssue } from "./messages.ts";
import { SaveResult, useSave } from "./use-save.tsx";

/** The entries a person typed: one per line, or separated by commas, semicolons or spaces. */
function splitEntries(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function isSignUpRuleKind(value: string): value is SignUpRuleKind {
  return value === "everyone" || value === "emails" || value === "domains";
}

export function SignUpRuleForm({
  settings,
  api,
}: {
  settings: AdminSettingsView;
  /** Only tests pass this. */
  api?: AdminApi;
}) {
  const ids = useId();
  const rule = settings.signUpRule.value;
  const [kind, setKind] = useState<SignUpRuleKind>(rule.kind);
  const [entriesText, setEntriesText] = useState(
    rule.kind === "everyone" ? "" : rule.entries.join("\n"),
  );
  const { pending, status, save } = useSave(api);
  const focusTargetRef = useFocusFirstError();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const [outcome] = await save({
      signUp:
        kind === "everyone"
          ? { kind: "everyone" }
          : { kind, entries: splitEntries(entriesText) },
    });
    if (outcome?.kind === "failed")
      focusTargetRef.current =
        outcome.issues[0]?.field === "signUp.entries"
          ? `${ids}-entries`
          : `${ids}-rule`;
  }

  const entriesIssue =
    status?.kind === "failed"
      ? status.issues.find((issue) => issue.field === "signUp.entries")
      : undefined;

  return (
    <form
      onSubmit={(event) => void submit(event)}
      aria-label="Sign-up rule"
      className="flex max-w-[44rem] flex-col gap-6"
    >
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-lg font-semibold tracking-tight">
              Who may sign up
            </h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <RadioGroup
            id={`${ids}-rule`}
            value={kind}
            onValueChange={(value) => {
              if (isSignUpRuleKind(value)) setKind(value);
            }}
            aria-label="Sign-up rule"
            className="gap-2"
          >
            {SIGN_UP_RULE_OPTIONS.map((option) => {
              const optionId = `${ids}-${option.value}`;
              const selected = option.value === kind;
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
          {kind === "everyone" ? null : (
            <Field>
              <FieldLabel htmlFor={`${ids}-entries`}>
                {kind === "emails" ? "Email addresses" : "Domains"}
              </FieldLabel>
              <Textarea
                id={`${ids}-entries`}
                rows={4}
                value={entriesText}
                onChange={(event) => setEntriesText(event.target.value)}
                aria-invalid={entriesIssue !== undefined}
                aria-describedby={`${ids}-hint`}
              />
              <FieldDescription id={`${ids}-hint`}>
                One per line, or separated by commas. Upper and lower case are
                the same.
              </FieldDescription>
              {entriesIssue ? (
                <FieldError>{describeAdminIssue(entriesIssue)}</FieldError>
              ) : null}
            </Field>
          )}
          <FieldDescription>
            Changing the rule affects new accounts and new invitations. Accounts
            that exist are not deleted or locked.
          </FieldDescription>
          <LastChanged setting={settings.signUpRule} />
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={pending} loadingLabel="Saving">
          Save sign-up rule
        </Button>
        <SaveResult status={status} />
      </div>
    </form>
  );
}
