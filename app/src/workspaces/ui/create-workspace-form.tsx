// SPDX-License-Identifier: Apache-2.0

"use client";
// Creates a workspace (multi-tenant instances): a name, and the person becomes its Owner and lands in it.
// The name is checked on the server (1 to 80 characters, no line breaks); the field does not carry a
// second, hard-coded limit (#171).
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
      className="flex flex-col gap-4"
      aria-label="Create a workspace"
    >
      {problem !== null ? (
        <Alert variant="destructive">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : null}
      <Field>
        <FieldLabel htmlFor={id}>Name of the workspace</FieldLabel>
        <Input
          id={id}
          type="text"
          autoComplete="off"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <FieldDescription>1 to 80 characters.</FieldDescription>
      </Field>
      <Button
        type="submit"
        loading={pending}
        loadingLabel="Creating"
        className="w-full"
      >
        Create the workspace
      </Button>
    </form>
  );
}
