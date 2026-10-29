// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The dialog that adds or edits one catalog entry (#429): name (with the warning that members see it), description,
// provider, model id with "Check model", and the kinds the entry serves. A refusal is a stable code that
// catalog-messages.ts turns into a sentence next to its field, and the focus moves to the first field that was refused
// (rulebook R20). Changing the model behind a released entry asks first, with the number of projects that use it, as the
// server counted it when it refused the first attempt (decision C6); the dialog never decides that on its own.
import { useProductIdentity } from "@/product-identity/context";
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../components/button.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { Checkbox } from "../../components/ui/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.tsx";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldTitle,
} from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.tsx";
import type {
  AdminCatalogEntry,
  AdminCatalogProvider,
} from "../../model-catalog/admin-view.ts";
import { CATALOG_KINDS, MAX_NAME_CHARS } from "../../model-catalog/entries.ts";
import type { ProjectReviewKind } from "../../job-kind/job-kind.ts";
import type { RequestIssue } from "../../ui/json-request.ts";
import type { CatalogApi, EntryInput } from "./catalog-api.ts";
import {
  describeCatalogFailure,
  describeCatalogIssue,
  describeCheckSuccess,
} from "./catalog-messages.ts";
import { useFocusFirstError } from "./focus-first-error.tsx";

export const KIND_LABELS: Record<ProjectReviewKind, string> = {
  diff: "Diff",
  dynamic: "Dynamic",
};

/** The fields in the order the form shows them: the first refused one gets the focus. */
const FIELDS = ["name", "description", "provider", "modelId", "kinds"] as const;
type Field = (typeof FIELDS)[number];

type Checked =
  { kind: "ok"; verified: boolean } | { kind: "failed"; text: string } | null;

export function EntryDialog({
  entry,
  isDefault,
  providers,
  api,
  onClose,
  onSaved,
}: {
  /** The entry to edit, or null for a new one. */
  entry: AdminCatalogEntry | null;
  /** Whether the entry is the instance default of a kind. */
  isDefault: boolean;
  providers: AdminCatalogProvider[];
  api: CatalogApi;
  onClose: () => void;
  onSaved: () => void;
}) {
  const product = useProductIdentity();
  const ids = useId();
  const focusRef = useFocusFirstError();
  const [name, setName] = useState(entry?.name ?? "");
  const [description, setDescription] = useState(entry?.description ?? "");
  const [provider, setProvider] = useState(
    entry?.provider ?? providers[0]?.id ?? "",
  );
  const [modelId, setModelId] = useState(entry?.modelId ?? "");
  const [kinds, setKinds] = useState<ProjectReviewKind[]>(entry?.kinds ?? []);
  const [issues, setIssues] = useState<RequestIssue[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<Checked>(null);
  /** The change the server wants confirmed, with the number of projects it counted when it asked. */
  const [confirming, setConfirming] = useState<{
    input: EntryInput;
    projects: number | null;
  } | null>(null);

  const controlId = (field: Field) =>
    field === "kinds" ? `${ids}-kind-${CATALOG_KINDS[0]}` : `${ids}-${field}`;
  const issueOf = (field: Field) =>
    issues.find((candidate) => candidate.field === field);

  function toggleKind(kind: ProjectReviewKind, on: boolean) {
    setKinds(
      CATALOG_KINDS.filter((k) => (k === kind ? on : kinds.includes(k))),
    );
  }

  function showRefusal(code: string, given: RequestIssue[]) {
    const own = given.filter((issue) =>
      FIELDS.some((field) => field === issue.field),
    );
    setIssues(own);
    setFormError(
      own.length === 0 ? describeCatalogFailure(product, code) : null,
    );
    const first = FIELDS.find((field) =>
      own.some((issue) => issue.field === field),
    );
    if (first !== undefined) focusRef.current = controlId(first);
  }

  async function send(input: EntryInput, confirmed: boolean) {
    setPending(true);
    const result =
      entry === null
        ? await api.create(input)
        : await api.update(
            entry.id,
            confirmed ? { ...input, confirmModelChange: true } : input,
          );
    setPending(false);
    if (result.ok) {
      onSaved();
      return;
    }
    // The server decides whether the change of a model needs the confirmation, and counts the projects when it asks: the
    // number of the page, loaded some time ago, is not shown.
    if (result.code === "model_change_not_confirmed") {
      const projects = result.details?.projects;
      setConfirming({
        input,
        projects: typeof projects === "number" ? projects : null,
      });
      return;
    }
    showRefusal(result.code, result.issues);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setIssues([]);
    setFormError(null);
    if (kinds.length === 0) {
      showRefusal("kinds_invalid", [{ field: "kinds", code: "kinds_invalid" }]);
      return;
    }
    void send(
      {
        name: name.trim(),
        description: description.trim() === "" ? null : description.trim(),
        provider,
        modelId: modelId.trim(),
        kinds,
      },
      false,
    );
  }

  async function check() {
    setChecked(null);
    setChecking(true);
    const result = await api.check({
      provider,
      modelId: modelId.trim(),
      kinds,
    });
    setChecking(false);
    if (!result.ok) {
      const issue = result.issues[0];
      setChecked({
        kind: "failed",
        text:
          issue === undefined
            ? describeCatalogFailure(product, result.code)
            : describeCatalogIssue(product, issue),
      });
      return;
    }
    setChecked(
      result.data.ok
        ? { kind: "ok", verified: result.data.verified }
        : {
            kind: "failed",
            text: describeCatalogFailure(product, result.data.error),
          },
    );
  }

  function describedBy(field: Field, hint?: string) {
    return (
      [hint, issueOf(field) === undefined ? undefined : `${ids}-${field}-error`]
        .filter(Boolean)
        .join(" ") || undefined
    );
  }
  function error(field: Field) {
    const issue = issueOf(field);
    if (issue === undefined) return null;
    return (
      <FieldError id={`${ids}-${field}-error`}>
        {describeCatalogIssue(product, issue)}
      </FieldError>
    );
  }

  const projects = confirming?.projects ?? null;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {entry === null ? "Add a model" : `Edit ${entry.name}`}
          </DialogTitle>
          <DialogDescription>
            An entry is what members of a workspace billed via {product.name}
            choose from. They see its name, description and the name of its
            provider; the model stays with you.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={submit}
          noValidate
          aria-label={entry === null ? "Add a model" : `Edit ${entry.name}`}
          className="flex flex-col gap-5"
        >
          <Field data-invalid={issueOf("name") !== undefined}>
            <FieldLabel htmlFor={controlId("name")}>Name</FieldLabel>
            <Input
              id={controlId("name")}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={MAX_NAME_CHARS}
              autoComplete="off"
              aria-invalid={issueOf("name") !== undefined}
              aria-describedby={describedBy("name", `${ids}-name-hint`)}
            />
            <FieldDescription id={`${ids}-name-hint`}>
              Members of managed workspaces see this name, never the model
              behind it. Do not put the model, its id or its provider in it.
            </FieldDescription>
            {error("name")}
          </Field>

          <Field data-invalid={issueOf("description") !== undefined}>
            <FieldLabel htmlFor={controlId("description")}>
              Description
            </FieldLabel>
            <Input
              id={controlId("description")}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              autoComplete="off"
              aria-invalid={issueOf("description") !== undefined}
              aria-describedby={describedBy(
                "description",
                `${ids}-description-hint`,
              )}
            />
            <FieldDescription id={`${ids}-description-hint`}>
              Optional, one line for members: speed and depth, no model, vendor
              or price.
            </FieldDescription>
            {error("description")}
          </Field>

          <Field data-invalid={issueOf("provider") !== undefined}>
            <FieldLabel htmlFor={controlId("provider")}>Provider</FieldLabel>
            <Select
              value={provider}
              onValueChange={(value) => {
                setProvider(value);
                setChecked(null);
              }}
            >
              <SelectTrigger
                id={controlId("provider")}
                className="w-full"
                aria-invalid={issueOf("provider") !== undefined}
                aria-describedby={describedBy("provider")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providers.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {error("provider")}
          </Field>

          <Field data-invalid={issueOf("modelId") !== undefined}>
            <FieldLabel htmlFor={controlId("modelId")}>Model id</FieldLabel>
            <div className="flex items-start gap-2">
              <Input
                id={controlId("modelId")}
                value={modelId}
                onChange={(event) => {
                  setModelId(event.target.value);
                  setChecked(null);
                }}
                spellCheck={false}
                autoComplete="off"
                className="font-mono"
                aria-invalid={issueOf("modelId") !== undefined}
                aria-describedby={describedBy("modelId", `${ids}-modelId-hint`)}
              />
              <Button
                variant="secondary"
                loading={checking}
                loadingLabel="Checking the model"
                disabled={pending || modelId.trim() === ""}
                onClick={() => void check()}
              >
                Check model
              </Button>
            </div>
            <FieldDescription id={`${ids}-modelId-hint`}>
              The real id at the provider. Only you see it. Releasing the entry
              checks it with the provider again.
            </FieldDescription>
            {error("modelId")}
            <div aria-live="polite">
              {checked?.kind === "ok" ? (
                <p role="status" className="text-sm text-success">
                  {describeCheckSuccess(checked.verified)}
                </p>
              ) : null}
            </div>
            {checked?.kind === "failed" ? (
              <Alert variant="destructive">
                <AlertDescription>{checked.text}</AlertDescription>
              </Alert>
            ) : null}
          </Field>

          <Field data-invalid={issueOf("kinds") !== undefined}>
            <FieldTitle id={`${ids}-kinds`}>Serves</FieldTitle>
            <div
              role="group"
              aria-labelledby={`${ids}-kinds`}
              className="flex flex-wrap gap-5"
            >
              {CATALOG_KINDS.map((kind) => (
                <div key={kind} className="flex items-center gap-2">
                  <Checkbox
                    id={`${ids}-kind-${kind}`}
                    checked={kinds.includes(kind)}
                    onCheckedChange={(value) => {
                      toggleKind(kind, value === true);
                      setChecked(null);
                    }}
                    aria-invalid={issueOf("kinds") !== undefined}
                    aria-describedby={describedBy("kinds")}
                  />
                  <Label htmlFor={`${ids}-kind-${kind}`}>
                    {KIND_LABELS[kind]}
                  </Label>
                </div>
              ))}
            </div>
            {error("kinds")}
          </Field>

          {formError === null ? null : (
            <Alert variant="destructive">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button variant="ghost" disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={pending} loadingLabel="Saving">
              Save
            </Button>
          </DialogFooter>
        </form>

        <AlertDialog
          open={confirming !== null}
          onOpenChange={(open) => (open ? undefined : setConfirming(null))}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Change the model behind {entry?.name ?? "this entry"}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                {projects === null
                  ? "Projects may use this entry, and their next reviews run on the new model."
                  : projects === 0
                    ? "No project uses this entry yet."
                    : `${String(projects)} ${projects === 1 ? "project uses" : "projects use"} this entry, and their next reviews run on the new model.`}{" "}
                {isDefault
                  ? "The count includes the projects that have chosen no model and fall back to this entry as the default. "
                  : null}
                The model is checked with the provider first, and the change is
                written to the server log with your account.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  const pending = confirming;
                  setConfirming(null);
                  if (pending !== null) void send(pending.input, true);
                }}
              >
                Change the model
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
