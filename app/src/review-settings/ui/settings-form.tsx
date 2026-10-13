// SPDX-License-Identifier: Apache-2.0

"use client";
// The review settings form, for the global defaults and for one project (#174). One form, one save:
// the three cards (Model, Review, When to review) read the values in force, and every field shows where
// its value comes from and can be taken back to the layer below with "Reset to default". A save
// replaces the whole set of the layer and is the only action in the footer; resetting the whole
// project to the defaults is a separate action in its own card at the bottom. Problems are checked
// before sending (the same validation the server runs, which checks again), shown as sentences at
// their field, and the first marked field gets the focus; the estimated cost updates while the person
// types and warns above the limit without blocking anything.
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Alert } from "../../components/ui/alert.tsx";
import { Button } from "../../components/button.tsx";
import { DangerZone } from "../../components/danger-zone.tsx";
import { formatUtc } from "../../ui/format-time.ts";
import { REVIEW_SETTING_FIELDS, type ReviewSettingField } from "../settings.ts";
import type { ReviewCostGuard } from "../cost.ts";
import { estimateReviewCost } from "../cost.ts";
import { MODEL_PRICES } from "../model-pricing.ts";
import {
  browserGlobalSettingsApi,
  browserProjectSettingsApi,
  type SettingsApi,
} from "./api.ts";
import { modelFromAnswer, type SettingsFormModel } from "./form-model.ts";
import {
  buildPatch,
  initialFormState,
  previewSettings,
  resetField,
  setBoolean,
  setCommand,
  setText,
  type BooleanField,
  type FormState,
  type TextField,
} from "./form-state.ts";
import { ModelFieldset } from "./model-fieldset.tsx";
import { ReviewFieldset } from "./review-fieldset.tsx";
import { WhenFieldset } from "./when-fieldset.tsx";
import type { SettingsFieldHandlers } from "./settings-fields.tsx";
import { describeIssue, describeSaveFailure } from "./messages.ts";
import type { RequestIssue } from "../../ui/json-request.ts";

type Errors = Partial<Record<string, string>>;

const SAVED_TEXT =
  "Saved. Reviews that start from now on use these values; a review that is already running keeps the values it started with.";

/**
 * Splits the problems of a save into those that belong to a field of the form and those that do not
 * (a problem with the settings as a whole, a field this version does not know): the second kind is
 * shown with the message at the foot of the form, never dropped.
 */
function splitIssues(issues: readonly RequestIssue[]): {
  fieldErrors: Errors;
  general: string[];
} {
  const fieldErrors: Errors = {};
  const general: string[] = [];
  for (const issue of issues) {
    const text = describeIssue(issue.field, issue.code);
    if ((REVIEW_SETTING_FIELDS as readonly string[]).includes(issue.field))
      fieldErrors[issue.field] = text;
    else general.push(text);
  }
  return { fieldErrors, general };
}

export function SettingsForm({
  workspaceSlug,
  initial,
  repositoryId,
  readOnly = false,
  api: apiOverride,
}: {
  /** The workspace of the page: the call is made in it. */
  workspaceSlug: string;
  initial: SettingsFormModel;
  /** The repository of the project being edited; required for a project form. */
  repositoryId?: string;
  /**
   * The values are shown and cannot be changed: the person's role does not allow it (the route refuses a
   * save in any case, src/workspaces/permissions.ts).
   */
  readOnly?: boolean;
  /** Only tests pass this: a server component cannot hand functions to this client component. */
  api?: SettingsApi;
}) {
  // One client for the life of the component: a new one every render would restart what depends on it.
  const defaultApi = useMemo(
    () =>
      initial.mode === "project" && repositoryId !== undefined
        ? browserProjectSettingsApi(workspaceSlug, repositoryId)
        : browserGlobalSettingsApi(workspaceSlug),
    [initial.mode, repositoryId, workspaceSlug],
  );
  const api = apiOverride ?? defaultApi;
  const datalistId = `${useId()}-models`;
  const formRef = useRef<HTMLFormElement>(null);
  const [model, setModel] = useState(initial);
  const [state, setState] = useState(() => initialFormState(initial));
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  // Bumped when a save was refused: the first marked field is focused then (rulebook R20).
  const [focusRequest, setFocusRequest] = useState(0);

  const preview = useMemo(() => previewSettings(model, state), [model, state]);
  const cost: ReviewCostGuard | null =
    preview === null ? null : estimateReviewCost(preview);

  // After the refusals are in the DOM, the first marked control takes the focus.
  useEffect(() => {
    if (focusRequest === 0) return;
    formRef.current
      ?.querySelector<HTMLElement>('[aria-invalid="true"]')
      ?.focus();
  }, [focusRequest]);

  // A change takes the problem of its field away: the estimate already works with the new value.
  function edit(next: FormState, changed: ReviewSettingField) {
    setState(next);
    setSaved(false);
    setErrors((current) => {
      if (current[changed] === undefined) return current;
      const rest = { ...current };
      delete rest[changed];
      return rest;
    });
  }

  function adopt(answer: unknown): boolean {
    const next = modelFromAnswer(model.mode, answer);
    if (next === null) return false;
    setModel(next);
    setState(initialFormState(next));
    setErrors({});
    return true;
  }

  function refuse(fieldErrors: Errors, message: string) {
    setErrors(fieldErrors);
    setFormError(message);
    setFocusRequest((count) => count + 1);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setSaved(false);
    setFormError(null);
    const built = buildPatch(state);
    if (!built.ok) {
      refuse(
        splitIssues(built.issues).fieldErrors,
        describeSaveFailure("REVIEW_SETTINGS_INVALID"),
      );
      return;
    }
    setErrors({});
    setBusy(true);
    const result = await api.save(built.patch);
    setBusy(false);
    if (!result.ok) {
      const { fieldErrors, general } = splitIssues(result.issues);
      refuse(
        fieldErrors,
        [describeSaveFailure(result.code), ...general].join(" "),
      );
      return;
    }
    if (!adopt(result.data))
      setFormError(describeSaveFailure("UNEXPECTED_RESPONSE"));
    else setSaved(true);
  }

  async function resetAll() {
    if (api.reset === undefined || busy) return;
    setSaved(false);
    setFormError(null);
    setBusy(true);
    const result = await api.reset();
    setBusy(false);
    if (!result.ok) {
      setFormError(describeSaveFailure(result.code));
      return;
    }
    if (!adopt(result.data))
      setFormError(describeSaveFailure("UNEXPECTED_RESPONSE"));
    else setSaved(true);
  }

  const handlers: SettingsFieldHandlers = {
    setText: (name: TextField, value: string) =>
      edit(setText(state, name, value), name),
    setBoolean: (name: BooleanField, value: boolean) =>
      edit(setBoolean(state, name, value), name),
    setCommand: (command, allowed) =>
      edit(setCommand(state, command, allowed), "allowedCommands"),
    reset: (name: ReviewSettingField) =>
      edit(resetField(state, name, model), name),
  };
  const disabled = busy || readOnly;
  const saveLabel =
    model.mode === "project" ? "Save review settings" : "Save defaults";

  return (
    <div className="flex max-w-[44rem] flex-col gap-6">
      <form
        ref={formRef}
        onSubmit={(event) => void submit(event)}
        aria-label="Review settings"
        noValidate
        className="flex flex-col gap-6"
      >
        <datalist id={datalistId}>
          {Object.keys(MODEL_PRICES).map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>

        <ModelFieldset
          model={model}
          state={state}
          errors={errors}
          disabled={disabled}
          handlers={handlers}
          cost={cost}
          datalistId={datalistId}
        />
        <ReviewFieldset
          model={model}
          state={state}
          errors={errors}
          disabled={disabled}
          handlers={handlers}
        />
        <WhenFieldset
          model={model}
          state={state}
          errors={errors}
          disabled={disabled}
          handlers={handlers}
        />
        {/* #200 adds the "Review kind" card here, between "When to review" and the footer. */}

        {formError !== null ? (
          <Alert variant="destructive">{formError}</Alert>
        ) : null}
        {saved ? (
          <Alert variant="success" role="status">
            {SAVED_TEXT}
          </Alert>
        ) : null}

        <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          {readOnly ? (
            <p className="text-sm text-muted-foreground">
              Only Admins and Owners can change these values.
            </p>
          ) : (
            <Button type="submit" loading={busy} loadingLabel="Saving">
              {saveLabel}
            </Button>
          )}
          {model.lastSaved !== null ? (
            <p className="text-sm text-muted-foreground">
              Last saved{" "}
              <time dateTime={model.lastSaved.at}>
                {formatUtc(model.lastSaved.at)}
              </time>
              {model.lastSaved.by !== null ? ` by ${model.lastSaved.by}` : ""}.
            </p>
          ) : null}
        </div>
      </form>

      {api.reset === undefined ? null : (
        <DangerZone
          title="Reset to defaults"
          description="Removes every value set for this project and follows the workspace defaults again."
          actionLabel="Reset everything"
          confirmTitle="Reset this project to the defaults?"
          confirmDescription="Every value set for this project is removed and the workspace defaults apply again. Reviews started afterwards use the defaults."
          confirmLabel="Reset to defaults"
          onConfirm={resetAll}
        />
      )}
    </div>
  );
}
