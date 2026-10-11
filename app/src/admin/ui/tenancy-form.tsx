"use client";
// The tenancy setting: one workspace for the whole instance (single-tenant) or workspaces that users
// create themselves (multi-tenant). The rules are the server's (src/admin/tenancy.ts); the form says
// them in advance and shows the reason when a change is refused.
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../ui/button.tsx";
import type { AdminSettingsView } from "../service.ts";
import type { AdminApi } from "./api.ts";
import { LastChanged } from "./last-changed.tsx";
import { SaveResult, useSave } from "./use-save.tsx";

export function TenancyForm({
  settings,
  api,
}: {
  settings: AdminSettingsView;
  /** Only tests pass this. */
  api?: AdminApi;
}) {
  const ids = useId();
  const [tenancy, setTenancy] = useState(settings.tenancy.value);
  const { pending, status, save } = useSave(api, settings.workspaceCount);

  function submit(event: FormEvent) {
    event.preventDefault();
    void save({ tenancy });
  }

  return (
    <form onSubmit={submit} className="settings-form" aria-labelledby={ids}>
      <h2 id={ids}>Tenancy</h2>
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
              One team, one workspace. Allowed only while this instance has at
              most one workspace ({String(settings.workspaceCount)} now).
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
              Everybody who can sign up may create workspaces. The workspaces
              and members that exist stay as they are.
            </span>
          </span>
        </label>
      </fieldset>
      <LastChanged setting={settings.tenancy} />
      <div className="form-actions">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving..." : "Save tenancy"}
        </Button>
        <SaveResult status={status} />
      </div>
    </form>
  );
}
