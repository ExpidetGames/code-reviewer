// SPDX-License-Identifier: Apache-2.0

"use client";
// The three questions of the first-run setup: single or multi tenant, who may sign up, and the
// instance admin account. The server judges every answer (and says so with a code per field); this
// form only collects them, keeps them while the person goes back and forth, and shows the reasons.
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../ui/button.tsx";
import { browserSetupApi, type SetupApi, type WizardRequest } from "./api.ts";
import {
  describeSetupFailure,
  describeSetupIssue,
  PASSWORD_REASON,
  stepOfField,
} from "./messages.ts";

type RuleKind = "everyone" | "emails" | "domains";

/** The entries a person typed: one per line, or separated by commas, semicolons or spaces. */
export function splitEntries(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

const FAIL_CLOSED_HINT =
  "Until emails can be verified, nobody except you can sign up under this rule. A mail server or GitHub as the only sign-in method makes it work; you set either up in the admin area after the setup. The entries are saved now.";

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
  const [ruleKind, setRuleKind] = useState<RuleKind>(
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
        "admin.repeat": "The two passwords are not the same.",
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

  const heading = (
    <p className="muted" aria-live="polite">
      Step {step} of 3
    </p>
  );

  if (step === 1)
    return (
      <div className="setup-form">
        <h1>How is this instance used?</h1>
        {heading}
        <fieldset className="setup-options">
          <legend className="sr-only">Tenancy</legend>
          <label className="setup-option">
            <input
              type="radio"
              name="tenancy"
              checked={tenancy === "single"}
              onChange={() => setTenancy("single")}
            />
            <span>
              <strong>Single-tenant</strong>
              <span className="muted">
                One team. The instance has one workspace, and you are its owner.
                People you invite work in it.
              </span>
            </span>
          </label>
          <label className="setup-option">
            <input
              type="radio"
              name="tenancy"
              checked={tenancy === "multi"}
              onChange={() => setTenancy("multi")}
            />
            <span>
              <strong>Multi-tenant</strong>
              <span className="muted">
                Several unrelated teams. Everyone who signs up creates a
                workspace of their own. You run the instance.
              </span>
            </span>
          </label>
        </fieldset>
        {fieldError("tenancy") ? (
          <p role="alert" className="field-error">
            {fieldError("tenancy")}
          </p>
        ) : null}
        <p className="muted">You can change this later in the admin area.</p>
        <div className="form-actions">
          <Button onClick={() => setStep(2)}>Next</Button>
        </div>
      </div>
    );

  if (step === 2)
    return (
      <div className="setup-form">
        <h1>Who may sign up?</h1>
        {heading}
        {existingInstallation ? (
          <p className="muted">
            The list of allowed GitHub logins and the organization of the
            earlier version are not carried over as a rule: the people who
            passed them became members, and you can invite the others. Choose
            who may create an account from now on.
          </p>
        ) : null}
        <fieldset className="setup-options">
          <legend className="sr-only">Sign-up rule</legend>
          {(
            [
              [
                "everyone",
                "Everyone",
                "Anyone who can reach this instance may create an account.",
              ],
              [
                "emails",
                "A list of email addresses",
                "Only the addresses you list.",
              ],
              [
                "domains",
                "Allowed email domains",
                "Anyone with an address at one of the domains you list (example.com, not its subdomains).",
              ],
            ] as const
          ).map(([kind, title, text]) => (
            <label key={kind} className="setup-option">
              <input
                type="radio"
                name="rule"
                checked={ruleKind === kind}
                onChange={() => setRuleKind(kind)}
              />
              <span>
                <strong>{title}</strong>
                <span className="muted">{text}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {ruleKind === "everyone" ? null : (
          <div className="field">
            <label htmlFor={`${ids}-entries`} className="field-label">
              {ruleKind === "emails" ? "Email addresses" : "Domains"}
            </label>
            <textarea
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
            <span className="muted">One per line, or separated by commas.</span>
            {fieldError("signUp.entries") ? (
              <p role="alert" className="field-error">
                {fieldError("signUp.entries")}
              </p>
            ) : null}
            <p className="alert alert-warning">{FAIL_CLOSED_HINT}</p>
          </div>
        )}
        <div className="form-actions">
          <Button variant="secondary" onClick={() => setStep(1)}>
            Back
          </Button>
          <Button onClick={nextFromRule}>Next</Button>
        </div>
      </div>
    );

  return (
    <form onSubmit={(event) => void finish(event)} className="setup-form">
      <h1>Create the admin account</h1>
      {heading}
      <p className="muted">
        The admin runs this instance: settings, integrations and mail. You sign
        in with this email address and password.
      </p>
      <div className="field">
        <label htmlFor={`${ids}-email`} className="field-label">
          Email address
        </label>
        <input
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
          <p role="alert" className="field-error">
            {fieldError("admin.email")}
          </p>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor={`${ids}-password`} className="field-label">
          Password
        </label>
        <input
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
        <span id={`${ids}-reason`} className="muted">
          {PASSWORD_REASON}
        </span>
        {fieldError("admin.password") ? (
          <p role="alert" className="field-error">
            {fieldError("admin.password")}
          </p>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor={`${ids}-repeat`} className="field-label">
          Repeat the password
        </label>
        <input
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
          <p role="alert" className="field-error">
            {fieldError("admin.repeat")}
          </p>
        ) : null}
      </div>
      {problem === null ? null : (
        <p role="alert" className="alert alert-error">
          {problem}
        </p>
      )}
      <div className="form-actions">
        <Button variant="secondary" onClick={() => setStep(2)}>
          Back
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Finishing..." : "Finish setup"}
        </Button>
      </div>
    </form>
  );
}
