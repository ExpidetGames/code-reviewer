// SPDX-License-Identifier: Apache-2.0

"use client";
// The three questions of the first-run setup: single or multi tenant, who may sign up, and the
// instance admin account. Each step is one real form with an accessible name, its heading sits
// outside that form, and a visible stepper says which step of three this is (#172). The server judges
// every answer (and says so with a code per field); this form only collects them, keeps them while
// the person goes back and forth, and shows the reasons.
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/button.tsx";
import { HelpDisclosure } from "@/components/help-disclosure.tsx";
import { InfoHint } from "@/components/info-hint.tsx";
import { FieldError } from "@/components/ui/field.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
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

/** The two answers of step 1, each with the one line that tells them apart. */
const TENANCY_OPTIONS = [
  {
    value: "single",
    title: "Single-tenant",
    text: "One team. The instance has one workspace, and you are its owner. People you invite work in it.",
  },
  {
    value: "multi",
    title: "Multi-tenant",
    text: "Several unrelated teams. Everyone who signs up creates a workspace of their own. You run the instance.",
  },
] as const;

/** The label of the entry field of step 2, per rule. */
const ENTRIES_LABEL = {
  emails: "Email addresses",
  domains: "Domains",
} as const;

/** The share of the wizard done after `step`, for the progress element (a percentage). */
function progressPercent(step: 1 | 2 | 3): number {
  return Math.round((step / 3) * 100);
}

function isTenancyKind(value: string): value is "single" | "multi" {
  return value === "single" || value === "multi";
}

function isSignUpRuleKind(value: string): value is SignUpRuleKind {
  return value === "everyone" || value === "emails" || value === "domains";
}

/**
 * The heading of a step with the stepper under it: the question as the one `h1`, then "Step n of 3"
 * as text and a progress element that carries the same step for assistive technology (#172).
 */
function StepHeading({
  step,
  children,
}: {
  step: 1 | 2 | 3;
  children: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">{children}</h1>
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

/** The radio cards of a step: one choice per option, the selected one marked with the accent. */
function OptionCards({
  name,
  value,
  options,
  onSelect,
}: {
  name: string;
  value: string;
  options: ReadonlyArray<{ value: string; title: string; text: string }>;
  onSelect: (value: string) => void;
}) {
  const ids = useId();
  return (
    <RadioGroup aria-label={name} value={value} onValueChange={onSelect}>
      {options.map((option, index) => {
        const id = `${ids}-${String(index)}`;
        const selected = option.value === value;
        return (
          <Label
            key={option.value}
            htmlFor={id}
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-card p-4 transition-colors",
              "hover:border-ring focus-within:ring-2 focus-within:ring-ring/50",
              selected && "border-primary bg-accent",
            )}
          >
            <RadioGroupItem value={option.value} id={id} className="mt-0.5" />
            <span className="flex flex-col gap-1">
              <span className="font-medium text-foreground">
                {option.title}
              </span>
              <span className="text-sm text-muted-foreground">
                {option.text}
              </span>
            </span>
          </Label>
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
  /** Only tests pass these two. */
  api?: SetupApi;
  onDone?: (redirectTo: string) => void;
}) {
  const ids = useId();
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
      if (first !== undefined) setStep(stepOfField(first.field));
      return;
    }
    setProblem(describeSetupFailure(result.code));
  }

  if (step === 1)
    return (
      <div className="flex flex-col gap-6">
        <StepHeading step={1}>How is this instance used?</StepHeading>
        <form
          aria-label="Tenancy"
          onSubmit={(event) => {
            event.preventDefault();
            setStep(2);
          }}
          className="flex flex-col gap-4"
        >
          <OptionCards
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
          <p className="text-sm text-muted-foreground">
            You can change this later in the admin area.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit">Next</Button>
          </div>
        </form>
      </div>
    );

  if (step === 2)
    return (
      <div className="flex flex-col gap-6">
        <StepHeading step={2}>Who may sign up?</StepHeading>
        <form
          aria-label="Sign-up rule"
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
            name="Sign-up rule"
            value={ruleKind}
            options={SIGN_UP_RULE_OPTIONS}
            onSelect={(value) => {
              if (isSignUpRuleKind(value)) setRuleKind(value);
            }}
          />
          {ruleKind === "everyone" ? null : (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5">
                <Label htmlFor={`${ids}-entries`}>
                  {ENTRIES_LABEL[ruleKind]}
                </Label>
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
              />
              <p className="text-sm text-muted-foreground">
                {FAIL_CLOSED_LINE}
              </p>
              {fieldError("signUp.entries") ? (
                <FieldError>{fieldError("signUp.entries")}</FieldError>
              ) : null}
            </div>
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
      <StepHeading step={3}>Create the admin account</StepHeading>
      <form
        aria-label="Admin account"
        onSubmit={(event) => void finish(event)}
        className="flex flex-col gap-4"
      >
        <p className="text-sm text-muted-foreground">
          The admin runs this instance and signs in with this email address and
          password.
        </p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-email`}>Email address</Label>
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
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <Label htmlFor={`${ids}-password`}>Password</Label>
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
          <p id={`${ids}-reason`} className="text-sm text-muted-foreground">
            {PASSWORD_RULE_HINT}
          </p>
          {fieldError("admin.password") ? (
            <FieldError>{fieldError("admin.password")}</FieldError>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-repeat`}>Repeat the password</Label>
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
        </div>
        {problem === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
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
