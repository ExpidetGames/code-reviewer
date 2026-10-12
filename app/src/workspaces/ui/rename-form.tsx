// SPDX-License-Identifier: Apache-2.0

"use client";
// Renames the workspace (an Owner; the address, the slug, stays).
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../ui/button.tsx";
import { browserWorkspaceApi, type WorkspaceApi } from "./api.ts";
import { describeWorkspaceFailure } from "./messages.ts";

export function RenameForm({
  workspaceSlug,
  initialName,
  api = browserWorkspaceApi(workspaceSlug),
}: {
  workspaceSlug: string;
  initialName: string;
  /** Only tests pass this. */
  api?: WorkspaceApi;
}) {
  const router = useRouter();
  const id = useId();
  const [name, setName] = useState(initialName);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setSaved(false);
    setPending(true);
    const result = await api.rename(name);
    setPending(false);
    if (!result.ok) {
      setProblem(describeWorkspaceFailure(result.code));
      return;
    }
    setName(result.data.name);
    setSaved(true);
    router.refresh();
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="settings-form"
      aria-label="Workspace name"
    >
      {problem !== null ? (
        <p role="alert" className="alert alert-error">
          {problem}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="alert alert-success">
          The name is saved.
        </p>
      ) : null}
      <div className="field">
        <label htmlFor={id} className="field-label">
          Name of the workspace
        </label>
        <input
          id={id}
          type="text"
          autoComplete="off"
          required
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="form-actions">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving..." : "Save the name"}
        </Button>
      </div>
    </form>
  );
}
