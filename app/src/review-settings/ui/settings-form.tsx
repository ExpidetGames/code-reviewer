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
import { Button } from "../../components/button.tsx";
import { DangerZone } from "../../components/danger-zone.tsx";
import { formatUtc } from "../../ui/format-time.ts";
import {
  PROJECT_DYNAMIC_SETTING_FIELDS,
  REVIEW_SETTING_FIELDS,
  type ProjectReviewKind,
  type ReviewSettingField,
} from "../settings.ts";
import type { ReviewCostGuard } from "../cost.ts";
import { estimateReviewCost } from "../cost.ts";
import { MODEL_PRICES } from "../model-pricing.ts";
import {
  browserGlobalSettingsApi,
  browserProjectSettingsApi,
  type SettingsApi,
} from "./api.ts";
import {
  editSkill,
  resetSkill,
  setDynamicModel,
  setReviewKind,
  setSkillText,
} from "./dynamic-form-state.ts";
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
import { adoptCards, planProjectSave, type SaveStep } from "./project-save.ts";
import { ModelFieldset } from "./model-fieldset.tsx";
import { KIND_NAMES } from "../kind-names.ts";
import {
  GATE_OFF_WARNING,
  ReviewKindFieldset,
  type ReviewKindHandlers,
} from "./review-kind-fieldset.tsx";
import { ReviewFieldset } from "./review-fieldset.tsx";
import { WhenFieldset } from "./when-fieldset.tsx";
import type { SettingsFieldHandlers } from "./settings-fields.tsx";
import { describeIssue, describeSaveFailure } from "./messages.ts";
import type { RequestIssue } from "../../ui/json-request.ts";

type Errors = Partial<Record<string, string>>;

/** The Diff fields an agent review does not show: an error on one of them is hidden while Dynamic is chosen. */
const DIFF_ONLY_FIELDS: readonly string[] = [
  "model",
  "fallbackModel",
  "maxTokens",
  "largePrChunking",
  "inlineKeyIssues",
  "extraInstructions",
];
const DYNAMIC_ONLY_FIELDS: readonly string[] = ["dynamicModel", "reviewSkill"];

/** The kind that has a problem the selected kind does not show, or null. */
function hiddenProblemOf(
  errors: Errors,
  selected: ProjectReviewKind,
): ProjectReviewKind | null {
  const other = selected === "diff" ? "dynamic" : "diff";
  const hidden = selected === "diff" ? DYNAMIC_ONLY_FIELDS : DIFF_ONLY_FIELDS;
  return Object.keys(errors).some((field) => hidden.includes(field))
    ? other
    : null;
}

const UNCHANGED_TEXT = "No changes to save.";

function confirmText(
  kind: ProjectReviewKind,
  dynamicReviewEnabled: boolean,
): string {
  const base =
    "Reviews of this project that are still waiting are cancelled, and a review that is already running finishes. The next review posts a new summary comment on the pull request; the findings of the current comment are not carried over.";
  return kind === "dynamic" && !dynamicReviewEnabled
    ? `${base} ${GATE_OFF_WARNING}`
    : base;
}

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
    if (
      (REVIEW_SETTING_FIELDS as readonly string[]).includes(issue.field) ||
      (PROJECT_DYNAMIC_SETTING_FIELDS as readonly string[]).includes(
        issue.field,
      )
    )
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
  dynamicReviewEnabled = false,
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
  /**
   * Whether the instance has turned Dynamic Review on (the #195 gate). Unknown counts as off: the card
   * never implies that Dynamic Review works when it may not.
   */
  dynamicReviewEnabled?: boolean;
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
  const saveRef = useRef<HTMLButtonElement>(null);
  const [model, setModel] = useState(initial);
  const [state, setState] = useState(() => initialFormState(initial));
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  // The message of a request of the Review kind card that failed after another one was saved.
  const [kindError, setKindError] = useState<string | null>(null);
  const [status, setStatus] = useState<"saved" | "unchanged" | null>(null);
  const [busy, setBusy] = useState(false);
  // A save that waits for the person to confirm the switch of the review kind.
  const [confirming, setConfirming] = useState<{
    steps: SaveStep[];
    to: ProjectReviewKind;
  } | null>(null);
  // Bumped when a save was refused: the first marked field is focused then (rulebook R20).
  const [focusRequest, setFocusRequest] = useState(0);

  // The project form of a repository holds the project-only settings (#194); the global form does not.
  const projectView = model.mode === "project" ? model.dynamic : undefined;
  const kind: ProjectReviewKind = state.dynamic?.reviewKind ?? "diff";
  const preview = useMemo(() => previewSettings(model, state), [model, state]);
  const cost: ReviewCostGuard | null =
    preview === null ? null : estimateReviewCost(preview);
  // Whether anything differs from what was loaded; the person can take it all back.
  const dirty = useMemo(() => {
    if (projectView === undefined) return false;
    const plan = planProjectSave(model, state);
    return !plan.ok || plan.steps.length > 0;
  }, [model, projectView, state]);
  const hiddenProblem =
    projectView === undefined ? null : hiddenProblemOf(errors, kind);

  // After the refusals are in the DOM, the first marked control takes the focus; a problem in a field
  // the selected kind does not show, or a failure that belongs to no field, takes it instead.
  useEffect(() => {
    if (focusRequest === 0) return;
    const form = formRef.current;
    const target =
      form?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
      form?.querySelector<HTMLElement>("[data-hidden-problem]") ??
      form?.querySelector<HTMLElement>("[data-kind-error]") ??
      form?.querySelector<HTMLElement>("[data-form-error]");
    target?.focus();
  }, [focusRequest]);

  // A change takes the problem of its field away: the estimate already works with the new value.
  function edit(next: FormState, changed: string) {
    setState(next);
    setStatus(null);
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

  // The requests of one project save, in order. The first failure stops the rest; what an earlier
  // request saved stays saved and is shown as saved, the cards of the failed request keep their edits.
  async function runSteps(steps: SaveStep[]) {
    setBusy(true);
    let currentModel = model;
    let currentState = state;
    for (const [index, step] of steps.entries()) {
      const result = await api.save(step.body);
      if (!result.ok) {
        setBusy(false);
        const { fieldErrors, general } = splitIssues(result.issues);
        const failure = [describeSaveFailure(result.code), ...general].join(
          " ",
        );
        const partial = index > 0;
        // After a saved first request, the card of the failed one says what was not saved.
        if (partial && step.cards.length === 1 && step.cards[0] === "kind")
          setKindError(`Not saved. ${failure}`);
        refuse(
          fieldErrors,
          partial
            ? `Some changes were saved, the others were not. ${failure}`
            : failure,
        );
        return;
      }
      const next = modelFromAnswer("project", result.data);
      if (next === null) {
        setBusy(false);
        refuse({}, describeSaveFailure("UNEXPECTED_RESPONSE"));
        return;
      }
      currentModel = next;
      currentState = adoptCards(currentState, next, step.cards);
      setModel(currentModel);
      setState(currentState);
    }
    setBusy(false);
    setErrors({});
    setStatus("saved");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setStatus(null);
    setFormError(null);
    setKindError(null);
    if (projectView !== undefined) {
      const plan = planProjectSave(model, state);
      if (!plan.ok) {
        refuse(
          splitIssues(plan.issues).fieldErrors,
          describeSaveFailure("REVIEW_SETTINGS_INVALID"),
        );
        return;
      }
      setErrors({});
      // An untouched form sends nothing: an empty request would clear the Diff overrides.
      if (plan.steps.length === 0) {
        setStatus("unchanged");
        return;
      }
      if (plan.kindChange !== null) {
        setConfirming({ steps: plan.steps, to: plan.kindChange.to });
        return;
      }
      await runSteps(plan.steps);
      return;
    }
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
    else setStatus("saved");
  }

  async function resetAll() {
    if (api.reset === undefined || busy) return;
    setStatus(null);
    setFormError(null);
    setKindError(null);
    setBusy(true);
    const result = await api.reset();
    setBusy(false);
    if (!result.ok) {
      setFormError(describeSaveFailure(result.code));
      return;
    }
    if (!adopt(result.data))
      setFormError(describeSaveFailure("UNEXPECTED_RESPONSE"));
    else setStatus("saved");
  }

  // Takes every unsaved change back to what was loaded; nothing is sent.
  function discard() {
    setState(initialFormState(model));
    setErrors({});
    setFormError(null);
    setKindError(null);
    setStatus(null);
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
  const shippedSkill = projectView?.defaults.reviewSkill ?? "";
  const kindHandlers: ReviewKindHandlers = {
    setKind: (next) => edit(setReviewKind(state, next), "reviewKind"),
    setModel: (text) => edit(setDynamicModel(state, text), "dynamicModel"),
    editSkill: () => edit(editSkill(state, shippedSkill), "reviewSkill"),
    setSkill: (text) => edit(setSkillText(state, text), "reviewSkill"),
    resetSkill: () => edit(resetSkill(state, shippedSkill), "reviewSkill"),
  };
  const disabled = busy || readOnly;
  const saveLabel =
    model.mode === "project" ? "Save review settings" : "Save review defaults";

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

        {projectView !== undefined && state.dynamic !== undefined ? (
          <ReviewKindFieldset
            view={projectView}
            values={state.dynamic}
            errors={errors}
            disabled={disabled}
            dynamicReviewEnabled={dynamicReviewEnabled}
            hiddenProblem={hiddenProblem}
            kindError={kindError}
            handlers={kindHandlers}
          />
        ) : null}
        {kind === "diff" ? (
          <ModelFieldset
            model={model}
            state={state}
            errors={errors}
            disabled={disabled}
            handlers={handlers}
            cost={cost}
            datalistId={datalistId}
          />
        ) : null}
        <ReviewFieldset
          model={model}
          state={state}
          errors={errors}
          disabled={disabled}
          handlers={handlers}
          kind={kind}
        />
        <WhenFieldset
          model={model}
          state={state}
          errors={errors}
          disabled={disabled}
          handlers={handlers}
        />

        {formError !== null ? (
          <Alert variant="destructive" tabIndex={-1} data-form-error="">
            {formError}
          </Alert>
        ) : null}
        {status === "saved" ? (
          <Alert variant="success" role="status">
            {SAVED_TEXT}
          </Alert>
        ) : null}
        {status === "unchanged" ? (
          <Alert variant="info" role="status">
            {UNCHANGED_TEXT}
          </Alert>
        ) : null}

        <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          {readOnly ? (
            <p className="text-sm text-muted-foreground">
              Only Admins and Owners can change these values.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                ref={saveRef}
                type="submit"
                loading={busy}
                loadingLabel="Saving"
              >
                {saveLabel}
              </Button>
              {dirty && !busy ? (
                <Button variant="ghost" onClick={discard}>
                  Discard changes
                </Button>
              ) : null}
            </div>
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

      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            // There is no trigger to return to: the focus goes back to the Save button.
            event.preventDefault();
            saveRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              Switch to {KIND_NAMES[confirming?.to ?? kind]}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmText(confirming?.to ?? kind, dynamicReviewEnabled)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirming !== null) void runSteps(confirming.steps);
              }}
            >
              Switch to {KIND_NAMES[confirming?.to ?? kind]}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
