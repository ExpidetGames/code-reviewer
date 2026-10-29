// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The one thing "Advanced" holds (#658): deleting the workspace. A danger card with the confirmation in an AlertDialog that
// asks for the name of the workspace to be typed, so a stray click cannot do it. A refusal (credit left, a review running) is
// said inside the dialog, which stays open; on success the person is sent to the start page, which leads to a workspace they
// still have or to the page that says what to do without one.
import { useProductIdentity } from "../../product-identity/context.tsx";
import { TrashIcon } from "@phosphor-icons/react/dist/ssr";
import { useId, useState, type FormEvent } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../components/ui/alert-dialog.tsx";
import { Button } from "../../components/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import { Field, FieldError, FieldLabel } from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import { browserWorkspaceApi, type WorkspaceApi } from "./api.ts";
import { DELETE_WORKSPACE_COPY, describeWorkspaceFailure } from "./messages.ts";

export function DeleteWorkspaceCard({
  workspaceSlug,
  workspaceName,
  api = browserWorkspaceApi(workspaceSlug),
  navigate = (path) => window.location.assign(path),
}: {
  workspaceSlug: string;
  workspaceName: string;
  /** Only tests pass these. */
  api?: Pick<WorkspaceApi, "deleteWorkspace">;
  navigate?: (path: string) => void;
}) {
  const product = useProductIdentity();
  const titleId = useId();
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const matches = typed.trim() === workspaceName;

  function change(next: boolean) {
    if (pending) return;
    setOpen(next);
    setTyped("");
    setProblem(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!matches || pending) return;
    setProblem(null);
    setPending(true);
    const result = await api.deleteWorkspace(typed.trim());
    if (!result.ok) {
      setPending(false);
      setProblem(describeWorkspaceFailure(product, result.code));
      return;
    }
    // The workspace is gone: the next page is a fresh load, nothing of it stays in the browser's router.
    navigate("/");
  }

  return (
    <Card
      className="border-destructive bg-background"
      role="region"
      aria-labelledby={titleId}
    >
      <CardHeader>
        <CardTitle>
          <h2 id={titleId} className="text-lg leading-7 tracking-normal">
            {DELETE_WORKSPACE_COPY.title}
          </h2>
        </CardTitle>
        <CardDescription>{DELETE_WORKSPACE_COPY.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex justify-end">
        <AlertDialog open={open} onOpenChange={change}>
          <AlertDialogTrigger asChild>
            <Button variant="destructive">
              <TrashIcon aria-hidden="true" />
              {DELETE_WORKSPACE_COPY.action}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <form
              onSubmit={(event) => void submit(event)}
              noValidate
              className="flex flex-col gap-4"
            >
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {DELETE_WORKSPACE_COPY.confirmTitle(workspaceName)}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {DELETE_WORKSPACE_COPY.confirmDescription}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <Field data-invalid={problem !== null || undefined}>
                <FieldLabel htmlFor={inputId}>
                  {DELETE_WORKSPACE_COPY.nameLabel(workspaceName)}
                </FieldLabel>
                <Input
                  id={inputId}
                  type="text"
                  autoComplete="off"
                  value={typed}
                  aria-invalid={problem !== null}
                  aria-describedby={
                    problem !== null ? `${inputId}-error` : undefined
                  }
                  onChange={(event) => setTyped(event.target.value)}
                />
                {problem !== null ? (
                  <FieldError id={`${inputId}-error`}>{problem}</FieldError>
                ) : null}
              </Field>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
                <Button
                  type="submit"
                  variant="destructive"
                  disabled={!matches}
                  loading={pending}
                  loadingLabel={DELETE_WORKSPACE_COPY.deleting}
                >
                  {DELETE_WORKSPACE_COPY.confirm}
                </Button>
              </AlertDialogFooter>
            </form>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
