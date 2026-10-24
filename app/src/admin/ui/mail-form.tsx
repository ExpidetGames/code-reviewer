// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The mail server: SMTP host, port, how the connection is secured, the login, the sender and a test mail
// (docs/decisions/0001-editions-setup-and-accounts.md, section 2.3). Mail is configured here and nowhere
// else. The password is write-only: the page shows whether one is saved, an empty field keeps it, the
// checkbox removes it, and the saved value never reaches this page. The server judges every field
// (src/mail/smtp-settings.ts); the form shows the reasons it gets back.
//
// Redesigned (#184): the "how it works" essay is a HelpDisclosure, the fields are the cards Connection
// and Sender with one Save, the removal lives in a DangerZone after the form, and only the warning of the
// selected security mode is shown.
import {
  useEffect,
  useId,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Button } from "../../components/button.tsx";
import { DangerZone } from "../../components/danger-zone.tsx";
import { HelpDisclosure } from "../../components/help-disclosure.tsx";
import { InfoHint } from "../../components/info-hint.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import { Checkbox } from "../../components/ui/checkbox.tsx";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldTitle,
} from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { PRODUCT_NAME } from "../../copy/product-name.ts";
import {
  RadioGroup,
  RadioGroupItem,
} from "../../components/ui/radio-group.tsx";
import {
  STORED_ENCRYPTED_HINT,
  UNREADABLE_SECRET_CAUSE,
} from "../../secrets/messages.ts";
import type { AdminSettingsView } from "../service.ts";
import { browserAdminApi, type AdminApi, type SmtpChange } from "./api.ts";
import { LastChanged } from "./last-changed.tsx";
import { describeAdminIssue } from "./messages.ts";
import { SaveResult, useSave } from "./use-save.tsx";

type Security = SmtpChange["security"];

const DEFAULT_PORT: Record<Security, number> = {
  starttls: 587,
  tls: 465,
  none: 25,
};

const SECURITY_OPTIONS: Array<{ value: Security; title: string }> = [
  { value: "starttls", title: "STARTTLS" },
  { value: "tls", title: "TLS" },
  { value: "none", title: "None (not encrypted)" },
];

// The order the fields appear in the card, so "the first error" is the one a person sees first,
// whatever order the server lists the issues in.
const FIELD_ORDER = [
  "host",
  "port",
  "security",
  "allowPlainTextLogin",
  "user",
  "password",
  "senderAddress",
  "senderName",
];

function firstInvalidField(
  issues: ReadonlyArray<{ field: string }>,
): string | null {
  let first: string | null = null;
  let firstIndex = FIELD_ORDER.length;
  for (const issue of issues) {
    const index = FIELD_ORDER.indexOf(issue.field);
    if (index === -1 || index >= firstIndex) continue;
    first = issue.field;
    firstIndex = index;
  }
  return first;
}

/** The id of the control an issue belongs to; the sender fields and the two checkboxes are not `ids-field`. */
function fieldElementId(ids: string, field: string): string {
  if (field === "allowPlainTextLogin") return `${ids}-plain-login`;
  if (field === "security") return `${ids}-security-starttls`;
  if (field === "senderAddress") return `${ids}-sender-address`;
  if (field === "senderName") return `${ids}-sender-name`;
  return `${ids}-${field}`;
}

export function MailForm({
  settings,
  children,
  api = browserAdminApi,
}: {
  settings: AdminSettingsView;
  /**
   * The cards between the settings form and the danger zone (the test mail card), so the danger zone
   * stays last (#184).
   */
  children?: ReactNode;
  /** Only tests pass this. */
  api?: AdminApi;
}) {
  const ids = useId();
  const saved = settings.smtp.value;
  const [host, setHost] = useState(saved?.host ?? "");
  const [portText, setPortText] = useState(String(saved?.port ?? 587));
  const [security, setSecurity] = useState<Security>(
    saved?.security ?? "starttls",
  );
  const [user, setUser] = useState(saved?.user ?? "");
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [senderAddress, setSenderAddress] = useState(
    saved?.senderAddress ?? "",
  );
  const [senderName, setSenderName] = useState(saved?.senderName ?? "");
  const [allowSelfSigned, setAllowSelfSigned] = useState(
    saved?.allowSelfSigned ?? false,
  );
  const [allowPlainTextLogin, setAllowPlainTextLogin] = useState(
    saved?.allowPlainTextLogin ?? false,
  );
  const { pending, status, save } = useSave(api);

  const passwordState = settings.smtp.password;

  // A failed save only sets state; the focus moves after the render that shows the errors is committed
  // ("focus the first error", plan rule). The first error is the one that appears first in the card.
  useEffect(() => {
    if (status === null || status.kind !== "failed") return;
    const field = firstInvalidField(status.issues);
    if (field === null) return;
    const element = document.getElementById(fieldElementId(ids, field));
    if (element instanceof HTMLElement) element.focus();
  }, [ids, status]);

  function chooseSecurity(next: Security) {
    // The port follows the choice as long as it is still the usual port of the old choice.
    if (portText === String(DEFAULT_PORT[security]))
      setPortText(String(DEFAULT_PORT[next]));
    setSecurity(next);
    if (next === "none") setAllowSelfSigned(false);
    else setAllowPlainTextLogin(false);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void save({
      smtp: {
        host,
        // A text the field cannot hold is sent as it is, so the server's refusal is what the person sees.
        port: portText.trim() === "" ? Number.NaN : Number(portText),
        security,
        user,
        senderAddress,
        senderName,
        allowSelfSigned,
        // Only a login on a connection without encryption needs the confirmation.
        allowPlainTextLogin:
          security === "none" && user.trim() !== "" && allowPlainTextLogin,
        ...(password === "" ? {} : { password }),
        ...(clearPassword ? { clearPassword: true } : {}),
      },
    }).then((ok) => {
      if (!ok) return;
      setPassword("");
      setClearPassword(false);
    });
  }

  function remove() {
    void save({ smtp: null }).then((ok) => {
      if (!ok) return;
      // The mail server is gone: the form starts empty again.
      setHost("");
      setPortText("587");
      setSecurity("starttls");
      setUser("");
      setPassword("");
      setClearPassword(false);
      setSenderAddress("");
      setSenderName("");
      setAllowPlainTextLogin(false);
      setAllowSelfSigned(false);
    });
  }

  const issues = status?.kind === "failed" ? status.issues : [];
  const issueFor = (field: string) =>
    issues.find((entry) => entry.field === field);
  const error = (field: string) => {
    const issue = issueFor(field);
    return issue ? (
      <FieldError id={`${ids}-${field}-error`}>
        {describeAdminIssue(issue)}
      </FieldError>
    ) : null;
  };
  const invalid = (field: string) => issueFor(field) !== undefined;
  const described = (field: string, ...hints: Array<string | undefined>) =>
    [...hints, invalid(field) ? `${ids}-${field}-error` : undefined]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <>
      <form
        onSubmit={submit}
        aria-label="Mail server (SMTP)"
        className="flex flex-col gap-6"
      >
        <HelpDisclosure label="How this works">
          With a mail server people can confirm their email address, reset a
          password and get invitations by mail. The server connects from this
          host&apos;s own network, so enter only a mail server you trust. Mail
          is configured here, never in the environment.
        </HelpDisclosure>

        <Card role="region" aria-labelledby={`${ids}-connection`}>
          <CardHeader>
            <CardTitle>
              <h2
                id={`${ids}-connection`}
                className="text-lg font-semibold tracking-tight"
              >
                Connection
              </h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <Field data-invalid={invalid("host")}>
              <FieldLabel htmlFor={`${ids}-host`}>Host</FieldLabel>
              <Input
                id={`${ids}-host`}
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="smtp.example.com"
                value={host}
                onChange={(event) => setHost(event.target.value)}
                aria-invalid={invalid("host")}
                aria-describedby={described("host")}
              />
              {error("host")}
            </Field>

            <Field data-invalid={invalid("port")}>
              <FieldLabel htmlFor={`${ids}-port`}>Port</FieldLabel>
              <Input
                id={`${ids}-port`}
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={portText}
                onChange={(event) => setPortText(event.target.value)}
                aria-invalid={invalid("port")}
                aria-describedby={described("port", `${ids}-port-hint`)}
              />
              <FieldDescription id={`${ids}-port-hint`}>
                Usually 587; 465 with TLS. Below 1024 only 25, 465 and 587 are
                allowed.
              </FieldDescription>
              {error("port")}
            </Field>

            <Field>
              <FieldTitle id={`${ids}-security`}>Security</FieldTitle>
              <RadioGroup
                aria-labelledby={`${ids}-security`}
                value={security}
                onValueChange={(next) => chooseSecurity(next as Security)}
                className="gap-2"
              >
                {SECURITY_OPTIONS.map((option) => (
                  <div key={option.value} className="flex items-center gap-2">
                    <RadioGroupItem
                      value={option.value}
                      id={`${ids}-security-${option.value}`}
                    />
                    <Label htmlFor={`${ids}-security-${option.value}`}>
                      {option.title}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
              {error("security")}
            </Field>

            {security === "none" ? (
              <Alert variant="warning" role="note">
                <AlertDescription className="flex flex-col gap-3">
                  <span>
                    <strong>This connection is not encrypted.</strong> The mail,
                    the links in it and the password of the login would be sent
                    in the clear, so anyone on the way to the mail server could
                    read them. Use this only for a mail server on a network you
                    control.
                  </span>
                  {user.trim() === "" ? null : (
                    <span className="flex items-start gap-2">
                      <Checkbox
                        id={`${ids}-plain-login`}
                        checked={allowPlainTextLogin}
                        onCheckedChange={(checked) =>
                          setAllowPlainTextLogin(checked === true)
                        }
                        aria-invalid={invalid("allowPlainTextLogin")}
                        aria-describedby={
                          invalid("allowPlainTextLogin")
                            ? `${ids}-allowPlainTextLogin-error`
                            : undefined
                        }
                      />
                      <Label
                        htmlFor={`${ids}-plain-login`}
                        className="font-normal"
                      >
                        I understand that the login is sent without encryption
                      </Label>
                    </span>
                  )}
                  {error("allowPlainTextLogin")}
                </AlertDescription>
              </Alert>
            ) : (
              <>
                <Field>
                  <span className="flex items-start gap-2">
                    <Checkbox
                      id={`${ids}-self-signed`}
                      checked={allowSelfSigned}
                      onCheckedChange={(checked) =>
                        setAllowSelfSigned(checked === true)
                      }
                    />
                    <Label
                      htmlFor={`${ids}-self-signed`}
                      className="font-normal"
                    >
                      Accept a self-signed certificate
                    </Label>
                  </span>
                  <FieldDescription>
                    Off by default: the certificate of the mail server is
                    checked.
                  </FieldDescription>
                </Field>
                {allowSelfSigned ? (
                  <Alert variant="warning" role="note">
                    <AlertDescription>
                      <strong>The certificate is not checked at all.</strong>{" "}
                      Anyone who can get between this server and the mail server
                      could read the mail and the password. Turn this on only
                      for a mail server on a network you control.
                    </AlertDescription>
                  </Alert>
                ) : null}
              </>
            )}

            <Field data-invalid={invalid("user")}>
              <FieldLabel htmlFor={`${ids}-user`}>User</FieldLabel>
              <Input
                id={`${ids}-user`}
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={user}
                onChange={(event) => setUser(event.target.value)}
                aria-invalid={invalid("user")}
                aria-describedby={described("user", `${ids}-user-hint`)}
              />
              <FieldDescription id={`${ids}-user-hint`}>
                Leave empty for a mail server that needs no login.
              </FieldDescription>
              {error("user")}
            </Field>

            <Field data-invalid={invalid("password")}>
              <div className="flex items-center gap-1">
                <FieldLabel htmlFor={`${ids}-password`}>Password</FieldLabel>
                <InfoHint label="About the saved password">
                  {STORED_ENCRYPTED_HINT} Enter a new one to replace the saved
                  one.
                </InfoHint>
              </div>
              <Input
                id={`${ids}-password`}
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-invalid={invalid("password")}
                aria-describedby={described("password", `${ids}-password-hint`)}
              />
              {passwordState === "unreadable" ? (
                <Alert
                  variant="warning"
                  role="note"
                  id={`${ids}-password-hint`}
                >
                  <AlertDescription>
                    <strong>The saved password cannot be read.</strong>{" "}
                    {UNREADABLE_SECRET_CAUSE} Enter the password again and save.
                    Until then no mail can be sent.
                  </AlertDescription>
                </Alert>
              ) : (
                <FieldDescription id={`${ids}-password-hint`}>
                  {passwordState === "configured"
                    ? "A password is saved; leave the field empty to keep it."
                    : "No password is saved."}
                </FieldDescription>
              )}
              {error("password")}
              {passwordState === "none" ? null : (
                <span className="flex items-start gap-2">
                  <Checkbox
                    id={`${ids}-clear-password`}
                    checked={clearPassword}
                    onCheckedChange={(checked) =>
                      setClearPassword(checked === true)
                    }
                  />
                  <Label
                    htmlFor={`${ids}-clear-password`}
                    className="font-normal"
                  >
                    Remove the saved password
                  </Label>
                </span>
              )}
            </Field>
          </CardContent>
        </Card>

        <Card role="region" aria-labelledby={`${ids}-sender`}>
          <CardHeader>
            <CardTitle>
              <h2
                id={`${ids}-sender`}
                className="text-lg font-semibold tracking-tight"
              >
                Sender
              </h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <Field data-invalid={invalid("senderAddress")}>
              <FieldLabel htmlFor={`${ids}-sender-address`}>
                Sender address
              </FieldLabel>
              <Input
                id={`${ids}-sender-address`}
                type="text"
                inputMode="email"
                autoComplete="off"
                spellCheck={false}
                placeholder="code-reviewer@example.com"
                value={senderAddress}
                onChange={(event) => setSenderAddress(event.target.value)}
                aria-invalid={invalid("senderAddress")}
                aria-describedby={described("senderAddress")}
              />
              {error("senderAddress")}
            </Field>

            <Field data-invalid={invalid("senderName")}>
              <FieldLabel htmlFor={`${ids}-sender-name`}>
                Sender name (optional)
              </FieldLabel>
              <Input
                id={`${ids}-sender-name`}
                type="text"
                autoComplete="off"
                placeholder={PRODUCT_NAME}
                value={senderName}
                onChange={(event) => setSenderName(event.target.value)}
                aria-invalid={invalid("senderName")}
                aria-describedby={described("senderName")}
              />
              {error("senderName")}
            </Field>
          </CardContent>
        </Card>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            loading={pending}
            loadingLabel="Saving the mail server"
          >
            Save mail server
          </Button>
          <SaveResult status={status} />
        </div>
        <LastChanged setting={settings.smtp} />
      </form>

      {children}

      {saved === null ? null : (
        <DangerZone
          title="Danger zone"
          description="Only when you no longer want mail from code-review.com."
          actionLabel="Remove the mail server"
          confirmTitle="Remove the mail server?"
          confirmDescription="Sign-up rules that need to verify addresses stop working until there is one again."
          confirmLabel="Remove the mail server"
          onConfirm={remove}
        />
      )}
    </>
  );
}
