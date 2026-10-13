// SPDX-License-Identifier: Apache-2.0

"use client";
// Renames the workspace (an Owner; the address, the slug, stays). One form with one explicit save and
// the saved state inline next to it; a refused name is named under the field.
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../components/button.tsx";
import { StatusRegion } from "../../components/status-region.tsx";
import { Field, FieldError, FieldLabel } from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
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
      aria-label="Workspace name"
      noValidate
      className="flex max-w-[44rem] flex-col gap-4"
    >
      <Field data-invalid={problem !== null || undefined}>
        <FieldLabel htmlFor={id}>Name of the workspace</FieldLabel>
        <Input
          id={id}
          type="text"
          autoComplete="off"
          required
          maxLength={80}
          value={name}
          aria-invalid={problem !== null}
          aria-describedby={problem !== null ? `${id}-error` : undefined}
          onChange={(event) => setName(event.target.value)}
        />
        {problem !== null ? (
          <FieldError id={`${id}-error`}>{problem}</FieldError>
        ) : null}
      </Field>
      <div className="flex items-center gap-3">
        <Button type="submit" loading={pending} loadingLabel="Saving">
          Save the name
        </Button>
        {saved ? <StatusRegion>The name is saved.</StatusRegion> : null}
      </div>
    </form>
  );
}
