// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The three questions of the first-run setup: single or multi tenant, who may sign up, and the
// instance admin account. Each step is one real form named by its heading (`aria-labelledby`), which
// sits outside that form, and a visible stepper says which step of three this is (#172). The server
// judges every answer (and says so with a code per field); this form only collects them, keeps them
// while the person goes back and forth, and shows the reasons.
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/button.tsx";
import { HelpDisclosure } from "@/components/help-disclosure.tsx";
import { InfoHint } from "@/components/info-hint.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert.tsx";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Progress } from "@/components/ui/progress.tsx";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { cn } from "@/lib/utils";
import {
  PASSWORD_RULE_HINT,
  PASSWORDS_DO_NOT_MATCH,
} from "../../auth/password-policy.ts";
import {
  FAIL_CLOSED_WARNING,
  SIGN_UP_RULE_OPTIONS,
  type SignUpRuleKind,
} from "../../signup/ui/rule-copy.ts";
import {
  TENANCY_OPTIONS,
  type TenancyKind,
} from "../../signup/ui/tenancy-copy.ts";
import { browserSetupApi, type SetupApi, type WizardRequest } from "./api.ts";
import {
  describeSetupFailure,
  describeSetupIssue,
  FAIL_CLOSED_LINE,
  PASSWORD_REASON,
  stepOfField,
} from "./messages.ts";

/** The entries a person typed: one per line, or separated by commas, semicolons or spaces. */
export function splitEntries(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/** The label of the entry field of step 2, per rule. */
const ENTRIES_LABEL = {
  emails: "Email addresses",
  domains: "Domains",
} as const;

/** The share of the wizard done after `step`, for the progress element (a percentage). */
function progressPercent(step: 1 | 2 | 3): number {
  return Math.round((step / 3) * 100);
}

function isTenancyKind(value: string): value is TenancyKind {
  return value === "single" || value === "multi";
}

function isSignUpRuleKind(value: string): value is SignUpRuleKind {
  return value === "everyone" || value === "emails" || value === "domains";
}

/** The control that carries the problem of a field, so the first one can be focused (rulebook R20). */
function controlId(ids: string, field: string): string {
  switch (field) {
    case "tenancy":
      return `${ids}-tenancy`;
    case "signUp.kind":
      return `${ids}-rule`;
    case "signUp.entries":
      return `${ids}-entries`;
    case "admin.email":
      return `${ids}-email`;
    case "admin.password":
      return `${ids}-password`;
    case "admin.repeat":
      return `${ids}-repeat`;
    default:
      return "";
  }
}

/** Focuses the control of `id`; a radio group has no input of its own, so the first radio gets it. */
function focusControl(id: string) {
  const element = document.getElementById(id);
  if (element === null) return;
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  ) {
    element.focus();
    return;
  }
  element.querySelector<HTMLElement>('[role="radio"]')?.focus();
}

/**
 * The heading of a step with the stepper under it: the question as the one `h1` (named by `id`, so
 * the step's form can be named by it), then "Step n of 3" as text and a progress element that
 * carries the same step for assistive technology (#172).
 */
function StepHeading({
  id,
  step,
  children,
}: {
  id: string;
  step: 1 | 2 | 3;
  children: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <h1 id={id} className="text-2xl font-semibold tracking-tight">
        {children}
      </h1>
      <div className="flex flex-col gap-1.5">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          Step {step} of 3
        </p>
        <Progress
          value={progressPercent(step)}
          aria-label="Setup progress"
          aria-valuetext={`Step ${step} of 3`}
        />
      </div>
    </div>
  );
}

/**
 * The radio cards of a step, built on the kit `Field` parts: one choice per option, the selected one
 * marked with the accent. The `RadioGroup` keeps its own accessible name (`name`), apart from the
 * form's, which is the step heading.
 */
function OptionCards({
  id,
  name,
  value,
  options,
  onSelect,
}: {
  id: string;
  name: string;
  value: string;
  options: ReadonlyArray<{ value: string; title: string; text: string }>;
  onSelect: (value: string) => void;
}) {
  const ids = useId();
  return (
    <RadioGroup
      id={id}
      aria-label={name}
      value={value}
      onValueChange={onSelect}
      className="gap-2"
    >
      {options.map((option, index) => {
        const optionId = `${ids}-${String(index)}`;
        const selected = option.value === value;
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
            <FieldDescription className="pl-7">{option.text}</FieldDescription>
          </Field>
        );
      })}
    </RadioGroup>
  );
}

export function Wizard({
  existingInstallation = false,
  api = browserSetupApi,
  onDone = (redirectTo: string) => window.location.assign(redirectTo),
}: {
  /**
   * An update of an installation from before accounts. The list of allowed logins and the organization of the
   * earlier version are not carried over as a rule, so "everyone" would be a bigger opening than the instance
   * had: the rule starts on "a list of email addresses" (fail-closed until addresses can be verified). All
   * three stay selectable.
   */
  existingInstallation?: boolean;
  /** Where the setup code comes from; only the sentence for an ended session differs (#321). */
  /** Only tests pass these two. */
  api?: SetupApi;
  onDone?: (redirectTo: string) => void;
}) {
  const ids = useId();
  const headingId = `${ids}-heading`;
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [tenancy, setTenancy] = useState<"single" | "multi">("single");
  const [ruleKind, setRuleKind] = useState<SignUpRuleKind>(
    existingInstallation ? "emails" : "everyone",
  );
  const [entriesText, setEntriesText] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [fieldProblems, setFieldProblems] = useState<Record<string, string>>(
    {},
  );
  // The field a refusal named: set in `finish`, read (and cleared) in the effect below, so focus
  // lands on it once the step that holds it has rendered (rulebook R20).
  const focusTarget = useRef<string | null>(null);

  useEffect(() => {
    const field = focusTarget.current;
    if (field === null) return;
    focusTarget.current = null;
    focusControl(controlId(ids, field));
  });

  function fieldError(field: string): string | undefined {
    return fieldProblems[field];
  }

  function nextFromRule() {
    if (ruleKind !== "everyone" && splitEntries(entriesText).length === 0) {
      setFieldProblems({
        "signUp.entries": describeSetupIssue(
          "signUp.entries",
          "entries_required",
        ),
      });
      return;
    }
    setFieldProblems({});
    setStep(3);
  }

  async function finish(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    if (password !== repeat) {
      setFieldProblems({
        "admin.repeat": PASSWORDS_DO_NOT_MATCH,
      });
      return;
    }
    setFieldProblems({});
    const body: WizardRequest = {
      tenancy,
      signUp:
        ruleKind === "everyone"
          ? { kind: "everyone" }
          : { kind: ruleKind, entries: splitEntries(entriesText) },
      admin: { email: email.trim(), password },
    };
    setPending(true);
    const result = await api.complete(body);
    setPending(false);
    if (result.ok) {
      onDone(result.data.redirectTo);
      return;
    }
    if (result.code === "invalid_input" && result.issues.length > 0) {
      const problems: Record<string, string> = {};
      for (const issue of result.issues)
        problems[issue.field] = describeSetupIssue(issue.field, issue.code);
      setFieldProblems(problems);
      const first = result.issues[0];
      if (first !== undefined) {
        setStep(stepOfField(first.field));
        focusTarget.current = first.field;
      }
      return;
    }
    setProblem(describeSetupFailure(result.code));
  }

  if (step === 1)
    return (
      <div className="flex flex-col gap-6">
        <StepHeading id={headingId} step={1}>
          How will it be used?
        </StepHeading>
        <form
          aria-labelledby={headingId}
          onSubmit={(event) => {
            event.preventDefault();
            setStep(2);
          }}
          className="flex flex-col gap-4"
        >
          <OptionCards
            id={`${ids}-tenancy`}
            name="Tenancy"
            value={tenancy}
            options={TENANCY_OPTIONS}
            onSelect={(value) => {
              if (isTenancyKind(value)) setTenancy(value);
            }}
          />
          {fieldError("tenancy") ? (
            <FieldError>{fieldError("tenancy")}</FieldError>
          ) : null}
          <FieldDescription>
            You can change this later in the admin area.
          </FieldDescription>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit">Next</Button>
          </div>
        </form>
      </div>
    );

  if (step === 2)
    return (
      <div className="flex flex-col gap-6">
        <StepHeading id={headingId} step={2}>
          Who may sign up?
        </StepHeading>
        <form
          aria-labelledby={headingId}
          onSubmit={(event) => {
            event.preventDefault();
            nextFromRule();
          }}
          className="flex flex-col gap-4"
        >
          {existingInstallation ? (
            <HelpDisclosure label="Why is this asked?">
              The list of allowed GitHub logins and the organization of the
              earlier version are not carried over as a rule: the people who
              passed them became members, and you can invite the others. Choose
              who may create an account from now on.
            </HelpDisclosure>
          ) : null}
          <OptionCards
            id={`${ids}-rule`}
            name="Sign-up rule"
            value={ruleKind}
            options={SIGN_UP_RULE_OPTIONS}
            onSelect={(value) => {
              if (isSignUpRuleKind(value)) setRuleKind(value);
            }}
          />
          {ruleKind === "everyone" ? null : (
            <Field>
              <div className="flex items-center gap-1.5">
                <FieldLabel htmlFor={`${ids}-entries`}>
                  {ENTRIES_LABEL[ruleKind]}
                </FieldLabel>
                <InfoHint label="Why this rule cannot verify anyone yet">
                  {FAIL_CLOSED_WARNING}
                </InfoHint>
              </div>
              <Textarea
                id={`${ids}-entries`}
                rows={4}
                value={entriesText}
                placeholder={
                  ruleKind === "emails"
                    ? "anna@example.com\nbob@example.org"
                    : "example.com"
                }
                onChange={(event) => setEntriesText(event.target.value)}
                aria-invalid={fieldError("signUp.entries") !== undefined}
                aria-describedby={`${ids}-entries-hint`}
              />
              <FieldDescription id={`${ids}-entries-hint`}>
                {FAIL_CLOSED_LINE}
              </FieldDescription>
              {fieldError("signUp.entries") ? (
                <FieldError>{fieldError("signUp.entries")}</FieldError>
              ) : null}
            </Field>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button type="submit">Next</Button>
          </div>
        </form>
      </div>
    );

  return (
    <div className="flex flex-col gap-6">
      <StepHeading id={headingId} step={3}>
        Create the admin account
      </StepHeading>
      <form
        aria-labelledby={headingId}
        onSubmit={(event) => void finish(event)}
        className="flex flex-col gap-4"
      >
        <FieldDescription>
          The admin runs it and signs in with this email address and password.
        </FieldDescription>
        <Field>
          <FieldLabel htmlFor={`${ids}-email`}>Email address</FieldLabel>
          <Input
            id={`${ids}-email`}
            type="email"
            name="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={fieldError("admin.email") !== undefined}
          />
          {fieldError("admin.email") ? (
            <FieldError>{fieldError("admin.email")}</FieldError>
          ) : null}
        </Field>
        <Field>
          <div className="flex items-center gap-1.5">
            <FieldLabel htmlFor={`${ids}-password`}>Password</FieldLabel>
            <InfoHint label="What makes a good password">
              {PASSWORD_REASON}
            </InfoHint>
          </div>
          <Input
            id={`${ids}-password`}
            type="password"
            name="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={fieldError("admin.password") !== undefined}
            aria-describedby={`${ids}-reason`}
          />
          <FieldDescription id={`${ids}-reason`}>
            {PASSWORD_RULE_HINT}
          </FieldDescription>
          {fieldError("admin.password") ? (
            <FieldError>{fieldError("admin.password")}</FieldError>
          ) : null}
        </Field>
        <Field>
          <FieldLabel htmlFor={`${ids}-repeat`}>Repeat the password</FieldLabel>
          <Input
            id={`${ids}-repeat`}
            type="password"
            name="repeat"
            autoComplete="new-password"
            required
            value={repeat}
            onChange={(event) => setRepeat(event.target.value)}
            aria-invalid={fieldError("admin.repeat") !== undefined}
          />
          {fieldError("admin.repeat") ? (
            <FieldError>{fieldError("admin.repeat")}</FieldError>
          ) : null}
        </Field>
        {problem === null ? null : (
          <Alert variant="destructive">
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={() => setStep(2)}>
            Back
          </Button>
          <Button type="submit" loading={pending}>
            {pending ? "Finishing..." : "Finish setup"}
          </Button>
        </div>
      </form>
    </div>
  );
}
