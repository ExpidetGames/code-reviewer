// SPDX-License-Identifier: Apache-2.0

"use client";
// The mail server: SMTP host, port, how the connection is secured, the login, the sender and a test mail
// (docs/decisions/0001-editions-setup-and-accounts.md, section 2.3). Mail is configured here and nowhere
// else. The password is write-only: the page shows whether one is saved, an empty field keeps it, the
// checkbox removes it, and the saved value never reaches this page. The server judges every field
// (src/mail/smtp-settings.ts); the form shows the reasons it gets back.
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../ui/button.tsx";
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

const SECURITY_OPTIONS: Array<{ value: Security; title: string; text: string }> = [
  {
    value: "starttls",
    title: "STARTTLS",
    text: "Starts unencrypted and switches to TLS before anything is sent (usually port 587). If the server does not offer it, nothing is sent.",
  },
  {
    value: "tls",
    title: "TLS",
    text: "Encrypted from the first byte (usually port 465).",
  },
  {
    value: "none",
    title: "None (not encrypted)",
    text: "Everything is sent in the clear.",
  },
];

export function MailForm({
  settings,
  api = browserAdminApi,
}: {
  settings: AdminSettingsView;
  /** Only tests pass this. */
  api?: AdminApi;
}) {
  const ids = useId();
  const saved = settings.smtp.value;
  const [host, setHost] = useState(saved?.host ?? "");
  const [portText, setPortText] = useState(String(saved?.port ?? 587));
  const [security, setSecurity] = useState<Security>(saved?.security ?? "starttls");
  const [user, setUser] = useState(saved?.user ?? "");
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [senderAddress, setSenderAddress] = useState(saved?.senderAddress ?? "");
  const [senderName, setSenderName] = useState(saved?.senderName ?? "");
  const [allowSelfSigned, setAllowSelfSigned] = useState(saved?.allowSelfSigned ?? false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const { pending, status, save } = useSave(api);

  const passwordState = settings.smtp.password;

  function chooseSecurity(next: Security) {
    // The port follows the choice as long as it is still the usual port of the old choice.
    if (portText === String(DEFAULT_PORT[security]))
      setPortText(String(DEFAULT_PORT[next]));
    setSecurity(next);
    if (next === "none") setAllowSelfSigned(false);
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
    setConfirmRemove(false);
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
      setAllowSelfSigned(false);
    });
  }

  const issues = status?.kind === "failed" ? status.issues : [];
  const issueFor = (field: string) => issues.find((entry) => entry.field === field);
  const error = (field: string) => {
    const issue = issueFor(field);
    return issue ? (
      <p id={`${ids}-${field}-error`} className="field-error">
        {describeAdminIssue(issue)}
      </p>
    ) : null;
  };
  const invalid = (field: string) => issueFor(field) !== undefined;
  const described = (field: string, hint?: string) =>
    [hint, invalid(field) ? `${ids}-${field}-error` : undefined]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <form onSubmit={submit} className="settings-form" aria-labelledby={ids}>
      <h2 id={ids}>Mail server (SMTP)</h2>
      <p className="muted">
        With a mail server people can confirm their email address, reset a
        password and get invitations by mail. Mail is configured here, never in
        the environment. This server connects to the host you enter from its own
        network, so enter only a mail server you trust.
      </p>
      {passwordState === "unreadable" ? (
        <p role="alert" className="alert alert-error">
          <strong>The saved password cannot be read.</strong> It was saved with
          another APP_SECRET, or the stored value was changed. Enter the password
          again and save. Until then no mail can be sent.
        </p>
      ) : null}

      <fieldset>
        <legend>Server</legend>
        <div className="field">
          <label htmlFor={`${ids}-host`} className="field-label">
            Host
          </label>
          <input
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
        </div>
        <div className="field">
          <label htmlFor={`${ids}-port`} className="field-label">
            Port
          </label>
          <input
            id={`${ids}-port`}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={portText}
            onChange={(event) => setPortText(event.target.value)}
            aria-invalid={invalid("port")}
            aria-describedby={described("port", `${ids}-port-hint`)}
          />
          <p id={`${ids}-port-hint`} className="muted small">
            Usually 587 for STARTTLS, 465 for TLS and 25 without encryption.
            Below 1024 only these three ports are allowed.
          </p>
          {error("port")}
        </div>
        <fieldset className="setup-options">
          <legend>Security of the connection</legend>
          {SECURITY_OPTIONS.map((option) => (
            <label key={option.value} className="setup-option">
              <input
                type="radio"
                name={`${ids}-security`}
                value={option.value}
                checked={security === option.value}
                onChange={() => chooseSecurity(option.value)}
              />
              <span>
                <strong>{option.title}</strong>
                <span className="muted">{option.text}</span>
              </span>
            </label>
          ))}
          {error("security")}
        </fieldset>
        {security === "none" ? (
          <p role="note" className="alert alert-warning">
            <strong>This connection is not encrypted.</strong> The mail, the
            links in it and the password of the login (if you set one) can be
            read by anyone on the way to the mail server. Use this only for a
            mail server on a network you control.
          </p>
        ) : (
          <div className="field">
            <label className="check">
              <input
                type="checkbox"
                checked={allowSelfSigned}
                onChange={(event) => setAllowSelfSigned(event.target.checked)}
              />
              <span>Accept a self-signed certificate</span>
            </label>
            <p className="muted small">
              Off by default: the certificate of the mail server is checked.
            </p>
            {allowSelfSigned ? (
              <p role="note" className="alert alert-warning">
                <strong>The certificate is not checked at all.</strong> Anyone
                who can get between this server and the mail server could read
                the mail and the password. Turn this on only for a mail server
                on a network you control.
              </p>
            ) : null}
          </div>
        )}
      </fieldset>

      <fieldset>
        <legend>Login</legend>
        <div className="field">
          <label htmlFor={`${ids}-user`} className="field-label">
            User
          </label>
          <input
            id={`${ids}-user`}
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={user}
            onChange={(event) => setUser(event.target.value)}
            aria-invalid={invalid("user")}
            aria-describedby={described("user", `${ids}-user-hint`)}
          />
          <p id={`${ids}-user-hint`} className="muted small">
            Leave empty for a mail server that needs no login.
          </p>
          {error("user")}
        </div>
        <div className="field">
          <label htmlFor={`${ids}-password`} className="field-label">
            Password
          </label>
          <input
            id={`${ids}-password`}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={invalid("password")}
            aria-describedby={described("password", `${ids}-password-hint`)}
          />
          <p id={`${ids}-password-hint`} className="muted small">
            {passwordState === "configured"
              ? "A password is saved. Leave the field empty to keep it, or enter a new one to replace it."
              : passwordState === "unreadable"
                ? "The saved password cannot be read. Enter it again."
                : "No password is saved."}{" "}
            It is stored encrypted and is never shown again.
          </p>
          {error("password")}
          {passwordState !== "none" ? (
            <label className="check">
              <input
                type="checkbox"
                checked={clearPassword}
                onChange={(event) => setClearPassword(event.target.checked)}
              />
              <span>Remove the saved password</span>
            </label>
          ) : null}
        </div>
      </fieldset>

      <fieldset>
        <legend>Sender</legend>
        <div className="field">
          <label htmlFor={`${ids}-sender`} className="field-label">
            Sender address
          </label>
          <input
            id={`${ids}-sender`}
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
        </div>
        <div className="field">
          <label htmlFor={`${ids}-name`} className="field-label">
            Sender name (optional)
          </label>
          <input
            id={`${ids}-name`}
            type="text"
            autoComplete="off"
            placeholder="Code Reviewer"
            value={senderName}
            onChange={(event) => setSenderName(event.target.value)}
            aria-invalid={invalid("senderName")}
            aria-describedby={described("senderName")}
          />
          {error("senderName")}
        </div>
      </fieldset>

      <LastChanged setting={settings.smtp} />
      <div className="form-actions">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving..." : "Save mail server"}
        </Button>
        <SaveResult status={status} />
      </div>

      {saved !== null ? (
        <div className="field">
          {confirmRemove ? (
            <p className="check-line" role="group" aria-label="Confirm removing the mail server">
              <span>
                Remove the mail server? Sign-up rules that need to verify
                addresses stop working until there is one again.
              </span>
              <Button variant="destructive" disabled={pending} onClick={remove}>
                Yes, remove it
              </Button>
              <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
                Keep it
              </Button>
            </p>
          ) : (
            <p>
              <Button
                variant="ghost"
                disabled={pending}
                onClick={() => setConfirmRemove(true)}
              >
                Remove the mail server
              </Button>
            </p>
          )}
        </div>
      ) : null}
    </form>
  );
}
