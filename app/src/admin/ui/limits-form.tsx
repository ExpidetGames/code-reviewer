"use client";
// The instance limits. For now one: how many workspaces a single user may own (the workspaces feature
// enforces it).
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../ui/button.tsx";
import type { AdminSettingsView } from "../service.ts";
import type { AdminApi } from "./api.ts";
import { LastChanged } from "./last-changed.tsx";
import { describeAdminIssue } from "./messages.ts";
import { SaveResult, useSave } from "./use-save.tsx";

export function LimitsForm({
  settings,
  api,
}: {
  settings: AdminSettingsView;
  /** Only tests pass this. */
  api?: AdminApi;
}) {
  const ids = useId();
  const [text, setText] = useState(String(settings.maxWorkspacesPerUser.value));
  const { pending, status, save } = useSave(api);

  function submit(event: FormEvent) {
    event.preventDefault();
    // A number the field cannot hold is sent as it is, so the server's refusal is what the person sees.
    void save({ limits: { maxWorkspacesPerUser: Number(text) } });
  }

  const issue =
    status?.kind === "failed"
      ? status.issues.find((entry) => entry.field === "maxWorkspacesPerUser")
      : undefined;

  return (
    <form onSubmit={submit} className="settings-form" aria-labelledby={ids}>
      <h2 id={ids}>Workspaces per user</h2>
      <div className="field">
        <label htmlFor={`${ids}-max`} className="field-label">
          Maximum number of workspaces one user may own
        </label>
        <input
          id={`${ids}-max`}
          type="text"
          inputMode="numeric"
          value={text}
          onChange={(event) => setText(event.target.value)}
          aria-invalid={issue !== undefined}
          aria-describedby={`${ids}-hint`}
        />
        <p id={`${ids}-hint`} className="muted small">
          The default is 10. It limits the workspaces a user creates in a
          multi-tenant instance.
        </p>
        {issue ? (
          <p className="field-error">{describeAdminIssue(issue)}</p>
        ) : null}
      </div>
      <LastChanged setting={settings.maxWorkspacesPerUser} />
      <div className="form-actions">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving..." : "Save limit"}
        </Button>
        <SaveResult status={status} />
      </div>
    </form>
  );
}
