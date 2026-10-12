// SPDX-License-Identifier: Apache-2.0

"use client";
// Creates a workspace (multi-tenant instances): a name, and the person becomes its Owner and lands in it.
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../ui/button.tsx";
import { workspaceHome } from "../paths.ts";
import { browserAccountApi, type AccountApi } from "./api.ts";
import { describeWorkspaceFailure } from "./messages.ts";

export function CreateWorkspaceForm({
  api = browserAccountApi,
  open = (path) => window.location.assign(path),
}: {
  /** Only tests pass these two. */
  api?: AccountApi;
  open?: (path: string) => void;
}) {
  const id = useId();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setPending(true);
    const result = await api.createWorkspace(name);
    if (!result.ok) {
      setPending(false);
      setProblem(describeWorkspaceFailure(result.code));
      return;
    }
    // A full navigation: the frame (the switcher) is made again with the new workspace in it.
    open(workspaceHome(result.data.workspace.slug));
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="login-form"
      aria-label="Create a workspace"
    >
      {problem !== null ? (
        <p role="alert" className="alert alert-error">
          {problem}
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
      <Button type="submit" className="btn-block" disabled={pending}>
        {pending ? "Creating..." : "Create the workspace"}
      </Button>
    </form>
  );
}
