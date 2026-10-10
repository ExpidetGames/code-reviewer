"use client";
// The review settings form, for the global defaults and for one project. Every field shows the value
// that is in force and where it comes from. Changing a field sets it for this layer; "Use default"
// takes it back so the layer inherits it again. A save replaces the whole set of the layer. Problems
// are checked before sending (the same validation the server runs, which checks again) and shown as
// sentences next to the field; the estimated cost updates while the person types and warns above the
// limit without blocking anything.
import {
  useId,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { REVIEW_COMMANDS } from "../../integrations/types.ts";
import { Button } from "../../ui/button.tsx";
import { estimateReviewCost } from "../cost.ts";
import { MODEL_PRICES } from "../model-pricing.ts";
import { REVIEW_SETTING_LIMITS, type ReviewSettingField } from "../settings.ts";
import {
  browserGlobalSettingsApi,
  browserProjectSettingsApi,
  type SettingsApi,
} from "./api.ts";
import { CostSummary } from "./cost-summary.tsx";
import { modelFromAnswer, type SettingsFormModel } from "./form-model.ts";
import {
  buildPatch,
  initialFormState,
  previewSettings,
  resetField,
  setBoolean,
  setCommand,
  setText,
  type FormState,
} from "./form-state.ts";
import { describeIssue, describeSaveFailure } from "./messages.ts";

type Errors = Partial<Record<string, string>>;
type ControlIds = {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
};

// The settings accept a fallback model, but the app does not send it to the runner yet (lead
// decision for the MVP, src/review-settings/README.md), so the form says so instead of promising it.
export const FALLBACK_MODEL_HINT =
  "Stored but not used yet: reviews do not switch to this model when the main model fails. Leave empty for none.";

const SAVED_TEXT =
  "Saved. Reviews that start from now on use these values; a review that is already running keeps the values it started with.";

function sourceText(
  model: SettingsFormModel,
  state: FormState,
  field: ReviewSettingField,
): string {
  if (state.overridden[field])
    return model.mode === "project"
      ? "Set for this project"
      : "Changed from the built-in value";
  if (model.mode === "global") return "Built-in value";
  return model.sources[field] === "global"
    ? "Global default"
    : "Built-in value";
}

export function SettingsForm({
  initial,
  repositoryId,
  api: apiOverride,
}: {
  initial: SettingsFormModel;
  /** The repository of the project being edited; required for a project form. */
  repositoryId?: string;
  /** Only tests pass this: a server component cannot hand functions to this client component. */
  api?: SettingsApi;
}) {
  const api =
    apiOverride ??
    (initial.mode === "project" && repositoryId !== undefined
      ? browserProjectSettingsApi(repositoryId)
      : browserGlobalSettingsApi);
  const prefix = useId();
  const [model, setModel] = useState(initial);
  const [state, setState] = useState(() => initialFormState(initial));
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const preview = useMemo(() => previewSettings(model, state), [model, state]);
  const cost = preview === null ? null : estimateReviewCost(preview);
  const resetLabel =
    model.mode === "project" ? "Use default" : "Use built-in value";

  function edit(next: FormState) {
    setState(next);
    setSaved(false);
  }

  function adopt(answer: unknown): boolean {
    const next = modelFromAnswer(model.mode, answer);
    if (next === null) return false;
    setModel(next);
    setState(initialFormState(next));
    setErrors({});
    return true;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setSaved(false);
    setFormError(null);
    const built = buildPatch(state);
    if (!built.ok) {
      setErrors(
        Object.fromEntries(
          built.issues.map((i) => [i.field, describeIssue(i.field, i.code)]),
        ),
      );
      setFormError(describeSaveFailure("REVIEW_SETTINGS_INVALID"));
      return;
    }
    setErrors({});
    setBusy(true);
    const result = await api.save(built.patch);
    setBusy(false);
    if (!result.ok) {
      setErrors(
        Object.fromEntries(
          result.issues.map((i) => [i.field, describeIssue(i.field, i.code)]),
        ),
      );
      setFormError(describeSaveFailure(result.code));
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

  function field(
    name: ReviewSettingField,
    label: string | null,
    control: (ids: ControlIds) => ReactNode,
    hint?: string,
  ) {
    const id = `${prefix}-${name}`;
    const error = errors[name];
    const describedBy =
      [
        hint !== undefined ? `${id}-hint` : null,
        error !== undefined ? `${id}-error` : null,
      ]
        .filter(Boolean)
        .join(" ") || undefined;
    return (
      <div className="field" data-field={name}>
        <div className="field-head">
          {label !== null ? <label htmlFor={id}>{label}</label> : <span />}
          <span className="badge badge-source">
            {sourceText(model, state, name)}
          </span>
          {state.overridden[name] ? (
            <button
              type="button"
              className="link-button"
              aria-label={`${resetLabel} for ${label ?? name}`}
              onClick={() => edit(resetField(state, name, model))}
            >
              {resetLabel}
            </button>
          ) : null}
        </div>
        {control({ id, describedBy, invalid: error !== undefined })}
        {hint !== undefined ? (
          <p id={`${id}-hint`} className="muted small">
            {hint}
          </p>
        ) : null}
        {error !== undefined ? (
          <p id={`${id}-error`} className="field-error">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  const textInput = (
    name: "model" | "fallbackModel" | "maxFindings" | "maxTokens",
    { id, describedBy, invalid }: ControlIds,
    extra: {
      list?: string;
      inputMode?: "numeric";
      placeholder?: string;
    } = {},
  ) => (
    <input
      id={id}
      type="text"
      autoComplete="off"
      spellCheck={false}
      value={state.values[name]}
      aria-invalid={invalid}
      aria-describedby={describedBy}
      onChange={(event) => edit(setText(state, name, event.target.value))}
      {...extra}
    />
  );

  const checkbox = (
    name:
      | "largePrChunking"
      | "inlineKeyIssues"
      | "autoReviewOnOpen"
      | "autoReviewOnPush",
    label: string,
    hint: string,
  ) =>
    field(
      name,
      null,
      ({ id, describedBy }) => (
        <label className="check" htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            checked={state.values[name]}
            aria-describedby={describedBy}
            onChange={(event) =>
              edit(setBoolean(state, name, event.target.checked))
            }
          />
          {label}
        </label>
      ),
      hint,
    );

  const datalistId = `${prefix}-models`;
  const instructionsLength = state.values.extraInstructions.length;
  return (
    <form
      className="settings-form"
      onSubmit={(event) => void submit(event)}
      noValidate
    >
      <datalist id={datalistId}>
        {Object.keys(MODEL_PRICES).map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>

      <fieldset>
        <legend>Model</legend>
        {field(
          "model",
          "Model",
          (ids) => textInput("model", ids, { list: datalistId }),
          "The model reviews run with, as OpenRouter spells it.",
        )}
        {field(
          "fallbackModel",
          "Fallback model",
          (ids) =>
            textInput("fallbackModel", ids, {
              list: datalistId,
              placeholder: "None",
            }),
          FALLBACK_MODEL_HINT,
        )}
        {field(
          "maxTokens",
          "Token budget",
          (ids) => textInput("maxTokens", ids, { inputMode: "numeric" }),
          `How much of a diff goes to the model at once, ${REVIEW_SETTING_LIMITS.maxTokens.min.toLocaleString("en-US")} to ${REVIEW_SETTING_LIMITS.maxTokens.max.toLocaleString("en-US")} tokens.`,
        )}
        <CostSummary cost={cost} />
      </fieldset>

      <fieldset>
        <legend>Review</legend>
        {field(
          "maxFindings",
          "Most findings per review",
          (ids) => textInput("maxFindings", ids, { inputMode: "numeric" }),
          `${String(REVIEW_SETTING_LIMITS.maxFindings.min)} to ${String(REVIEW_SETTING_LIMITS.maxFindings.max)}.`,
        )}
        {checkbox(
          "largePrChunking",
          "Review a large pull request in chunks",
          "Otherwise files that do not fit the token budget are left out.",
        )}
        {checkbox(
          "inlineKeyIssues",
          "Also post every finding as an inline comment",
          "On the line the finding is about.",
        )}
        {field(
          "extraInstructions",
          "Project rules",
          ({ id, describedBy, invalid }) => (
            <textarea
              id={id}
              rows={6}
              value={state.values.extraInstructions}
              aria-invalid={invalid}
              aria-describedby={describedBy}
              onChange={(event) =>
                edit(setText(state, "extraInstructions", event.target.value))
              }
            />
          ),
          `Free text added to every review prompt (${instructionsLength.toLocaleString("en-US")} of ${REVIEW_SETTING_LIMITS.extraInstructionsMaxChars.toLocaleString("en-US")} characters).`,
        )}
      </fieldset>

      <fieldset>
        <legend>When to review</legend>
        {checkbox(
          "autoReviewOnOpen",
          "Review when a pull request is opened, reopened or marked ready",
          "Draft pull requests wait until they are ready.",
        )}
        {checkbox(
          "autoReviewOnPush",
          "Review again when commits are pushed",
          "A short pause lets several pushes count as one.",
        )}
        {field("allowedCommands", null, ({ id, describedBy }) => (
          <div
            role="group"
            aria-labelledby={`${id}-label`}
            aria-describedby={describedBy}
            id={id}
          >
            <span id={`${id}-label`} className="field-label">
              Comment commands people may use
            </span>
            <div className="check-row">
              {REVIEW_COMMANDS.map((command) => (
                <label key={command} className="check">
                  <input
                    type="checkbox"
                    checked={state.values.allowedCommands.includes(command)}
                    onChange={(event) =>
                      edit(setCommand(state, command, event.target.checked))
                    }
                  />
                  /{command}
                </label>
              ))}
            </div>
          </div>
        ))}
      </fieldset>

      {formError !== null ? (
        <p role="alert" className="alert alert-error">
          {formError}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="alert alert-success">
          {SAVED_TEXT}
        </p>
      ) : null}

      <div className="form-actions">
        <Button type="submit" disabled={busy}>
          {busy
            ? "Saving..."
            : model.mode === "project"
              ? "Save project settings"
              : "Save defaults"}
        </Button>
        {api.reset !== undefined ? (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void resetAll()}
          >
            Use the defaults for everything
          </Button>
        ) : null}
        {model.lastSaved !== null ? (
          <span className="muted small">
            Last saved {model.lastSaved.at.slice(0, 16).replace("T", " ")} UTC
            {model.lastSaved.by !== null ? ` by ${model.lastSaved.by}` : ""}.
          </span>
        ) : null}
      </div>
    </form>
  );
}
