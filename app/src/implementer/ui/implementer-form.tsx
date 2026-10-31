// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The form that sends a task to the Implementer (#756): the repository (of those linked, one without write permission is listed
// but cannot be chosen), the base branch (the repository's default branch is preselected), the name of the new branch, the task, the
// model and an optional cost limit. It talks to the four routes of #755 only (`api.ts`), reads no secret and no token, and shows no
// text of GitHub: every refusal is a fixed sentence for its code (`messages.ts`).
//
// One form load is one task: the client request id is made once, at the first send, and every later send of this form (after a
// failed or a lost answer) carries the same id, so a retry that reaches the server twice starts one task.
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { Button } from "../../components/button.tsx";
import { Alert } from "../../components/ui/alert.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { useProductIdentity } from "../../product-identity/context.tsx";
import {
  ModelSelect,
  type ModelOption,
} from "../../review-settings/ui/model-select.tsx";
import { workspacePath } from "../../workspaces/paths.ts";
import { checkBranchName } from "../branch-name.ts";
import type { ImplementerIssue } from "../errors.ts";
import { INSTRUCTION_MAX_LENGTH, validateStartInput } from "../start-input.ts";
import {
  browserImplementerApi,
  type ImplementerApi,
  type StartTaskRequest,
} from "./api.ts";
import { suggestBranchName } from "./branch-suggestion.ts";
import { costLimitPlaceholder, parseCostLimit } from "./cost-limit.ts";
import { FormField } from "./form-field.tsx";
import {
  describeFieldIssue,
  describeImplementerFailure,
  FORM_COPY,
} from "./messages.ts";
import {
  hasModels,
  ModelPicker,
  modelChoiceOf,
  type ModelPick,
} from "./model-picker.tsx";
import { useRequest } from "./use-request.ts";

type FieldKey =
  "repository" | "baseBranch" | "branch" | "instruction" | "model" | "cost";
type Errors = Partial<Record<FieldKey, string>>;

const FIELD_OF_ISSUE: Record<ImplementerIssue["field"], FieldKey | null> = {
  repositoryId: "repository",
  baseBranch: "baseBranch",
  branch: "branch",
  instruction: "instruction",
  model: "model",
  costLimitCents: "cost",
  clientRequestId: null,
};

/** The field a refusal of the submit belongs to; the others are a sentence on the form. */
const FIELD_OF_FAILURE: Record<string, FieldKey> = {
  IMPLEMENTER_BRANCH_EXISTS: "branch",
  IMPLEMENTER_BRANCH_CONFLICT: "branch",
  IMPLEMENTER_BASE_BRANCH_NOT_FOUND: "baseBranch",
  IMPLEMENTER_MODEL_NOT_ALLOWED: "model",
  EXCEEDS_OPERATOR_MAXIMUM: "cost",
};

// Stable functions for `useRequest`.
const loadRepositories = (api: ImplementerApi) => api.repositories();
const loadModels = (api: ImplementerApi) => api.models();
const loadBranches = (api: ImplementerApi, repositoryId: string) =>
  api.branches(repositoryId);

const subscribeNothing = () => () => {};

/**
 * A value made once in the browser: empty in the HTML the server renders and in the first render of the browser that hydrates it,
 * then the made value. A prerendered random value would be the same for everybody, and a different one in the HTML and in the
 * browser would be a hydration mismatch.
 */
function useClientOnce(make: () => string): string {
  const made = useRef<string | null>(null);
  return useSyncExternalStore(
    subscribeNothing,
    () => (made.current ??= make()),
    () => "",
  );
}

function newClientRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function ImplementerForm({
  workspaceSlug,
  operatorMaximumCents,
  api: apiProp,
}: {
  /** The workspace of the page: the calls are made in it, and the run a task starts is linked in it. */
  workspaceSlug: string;
  /** The operator's maximum cost per task in whole US cents: the placeholder of the cost field and its upper bound. */
  operatorMaximumCents: number;
  /** Only tests pass this. */
  api?: ImplementerApi;
}) {
  const product = useProductIdentity();
  const router = useRouter();
  const [defaultApi] = useState(() => browserImplementerApi(workspaceSlug));
  const api = apiProp ?? defaultApi;
  const formRef = useRef<HTMLFormElement>(null);

  const [repositoryId, setRepositoryId] = useState("");
  // The base branch the person picked; the default branch applies until they pick another (and again after another repository).
  const [basePick, setBasePick] = useState("");
  // What the person typed; null while the suggestion stands.
  const [branchEdit, setBranchEdit] = useState<string | null>(null);
  const suggestion = useClientOnce(suggestBranchName);
  const branch = branchEdit ?? suggestion;
  const [instruction, setInstruction] = useState("");
  const [modelPick, setModelPick] = useState<ModelPick>({
    provider: "",
    model: "",
  });
  const [cost, setCost] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Set at once on a send (a state update comes too late for a second Enter) and kept after a success until the page is left.
  const sending = useRef(false);
  const requestId = useRef<string | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);

  const [repositories, reloadRepositories] = useRequest(
    api,
    "all",
    loadRepositories,
  );
  const [models, reloadModels] = useRequest(api, "all", loadModels);
  const [branches, reloadBranches] = useRequest(
    api,
    repositoryId === "" ? null : repositoryId,
    loadBranches,
  );

  // After a refused send the first field with a message gets the focus.
  useEffect(() => {
    if (focusRequest === 0) return;
    formRef.current
      ?.querySelector<HTMLElement>('[aria-invalid="true"]')
      ?.focus();
  }, [focusRequest]);

  const repositoryList =
    repositories.state === "ready" ? repositories.data.repositories : [];
  const eligible = repositoryList.filter(
    (repository) => repository.writeGranted,
  );
  const branchList = branches.state === "ready" ? branches.data : undefined;
  const baseBranch =
    branchList === undefined
      ? ""
      : basePick !== "" && branchList.branches.includes(basePick)
        ? basePick
        : branchList.defaultBranch;
  const modelOptions = models.state === "ready" ? models.data : undefined;
  const choice = modelChoiceOf(modelOptions, modelPick);

  function clear(...keys: FieldKey[]) {
    setErrors((current) => {
      const next = { ...current };
      for (const key of keys) delete next[key];
      return next;
    });
    setFormError(null);
  }

  function chooseRepository(id: string) {
    setRepositoryId(id);
    setBasePick("");
    clear("repository", "baseBranch", "branch");
  }

  /** What is wrong with the form as it stands, with the sentences of the server's own codes; the request when nothing is. */
  function check(): { request: StartTaskRequest } | { errors: Errors } {
    const found: Errors = {};
    const costLimit = parseCostLimit(cost, operatorMaximumCents);
    if (!costLimit.ok)
      found.cost =
        costLimit.code === "invalid"
          ? describeFieldIssue("costLimitCents", "invalid")
          : describeImplementerFailure(product, {
              code: "EXCEEDS_OPERATOR_MAXIMUM",
              maximumCents: costLimit.maximumCents,
            });
    requestId.current ??= newClientRequestId();
    const body = {
      repositoryId,
      baseBranch,
      branch,
      instruction,
      model: choice,
      ...(costLimit.ok && costLimit.cents !== null
        ? { costLimitCents: costLimit.cents }
        : {}),
      clientRequestId: requestId.current,
    };
    const checked = validateStartInput(body);
    if (!checked.ok)
      for (const issue of checked.issues) {
        const key = FIELD_OF_ISSUE[issue.field];
        // A base branch is asked for once there is a repository to ask it of.
        if (key === null || (key === "baseBranch" && repositoryId === ""))
          continue;
        found[key] ??= describeFieldIssue(issue.field, issue.code);
      }
    if (Object.keys(found).length > 0) return { errors: found };
    return { request: body as StartTaskRequest };
  }

  function checkBranch() {
    const result = checkBranchName(branch, baseBranch);
    setErrors((current) => {
      const next = { ...current };
      if (result.ok) delete next.branch;
      else next.branch = describeFieldIssue("branch", result.issue);
      return next;
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending.current || !canSend) return;
    const checked = check();
    if ("errors" in checked) {
      setErrors(checked.errors);
      setFormError(null);
      setFocusRequest((count) => count + 1);
      return;
    }
    sending.current = true;
    setPending(true);
    setErrors({});
    setFormError(null);
    const result = await api.startTask(checked.request);
    if (result.ok) {
      // Stay "sending" until the page changes: a second click on the way must not start a second task.
      router.push(
        workspacePath(
          workspaceSlug,
          `/runs/${encodeURIComponent(result.data.runId)}`,
        ),
      );
      return;
    }
    sending.current = false;
    setPending(false);
    const failure = {
      code: result.code,
      status: result.status,
      reason: result.details?.reason,
      maximumCents: result.details?.maximumCents,
    };
    const sentence = describeImplementerFailure(product, failure);
    const field = FIELD_OF_FAILURE[result.code];
    if (
      result.code === "IMPLEMENTER_REQUEST_INVALID" &&
      result.issues.length > 0
    ) {
      const found: Errors = {};
      let rest = false;
      for (const issue of result.issues) {
        const key = FIELD_OF_ISSUE[issue.field as ImplementerIssue["field"]];
        if (key === undefined || key === null) rest = true;
        else
          found[key] ??= describeFieldIssue(
            issue.field as ImplementerIssue["field"],
            issue.code,
          );
      }
      setErrors(found);
      setFormError(rest ? sentence : null);
    } else if (field !== undefined) {
      setErrors({ [field]: sentence });
    } else {
      setFormError(sentence);
    }
    // The base branch is gone: the list is out of date.
    if (result.code === "IMPLEMENTER_BASE_BRANCH_NOT_FOUND") reloadBranches();
    setFocusRequest((count) => count + 1);
  }

  const noWriteAnywhere =
    repositories.state === "ready" &&
    repositoryList.length > 0 &&
    eligible.length === 0;
  const canSend =
    repositories.state === "ready" &&
    eligible.length > 0 &&
    models.state === "ready" &&
    hasModels(models.data) &&
    branches.state !== "loading" &&
    branches.state !== "failed" &&
    !pending;

  if (repositories.state === "failed")
    return (
      <LoadFailure
        sentence={describeImplementerFailure(product, {
          code: repositories.failure.code,
          status: repositories.failure.status,
        })}
        onRetry={reloadRepositories}
      />
    );
  if (repositories.state === "ready" && repositoryList.length === 0)
    return (
      <Alert variant="info" role="status">
        {FORM_COPY.noRepositoryBefore}{" "}
        <Link
          href={workspacePath(workspaceSlug, "/connections")}
          className="font-semibold underline underline-offset-4"
        >
          {FORM_COPY.noRepositoryLink}
        </Link>{" "}
        {FORM_COPY.noRepositoryAfter}
      </Alert>
    );

  const repositoryOptions: ModelOption[] = repositoryList.map((repository) => ({
    id: repository.id,
    label: repository.fullName,
    ...(repository.writeGranted
      ? {}
      : { note: FORM_COPY.writeNote, disabled: true }),
  }));
  const branchOptions: ModelOption[] = (branchList?.branches ?? []).map(
    (name) => ({
      id: name,
      label: name,
      ...(name === branchList?.defaultBranch
        ? { note: FORM_COPY.defaultMark }
        : {}),
    }),
  );

  return (
    <form
      ref={formRef}
      noValidate
      className="flex max-w-2xl flex-col gap-6"
      onSubmit={(event) => void submit(event)}
    >
      {noWriteAnywhere ? (
        <Alert variant="warning">
          {describeImplementerFailure(product, {
            code: "IMPLEMENTER_WRITE_NOT_GRANTED",
          })}
        </Alert>
      ) : null}
      <fieldset disabled={pending} className="flex flex-col gap-6">
        <ModelSelect
          name="repository"
          label={FORM_COPY.repository}
          value={repositoryId}
          options={repositoryOptions}
          onChange={chooseRepository}
          error={errors.repository}
          disabled={repositories.state !== "ready"}
          placeholder={
            repositories.state === "ready"
              ? FORM_COPY.repositoryPlaceholder
              : FORM_COPY.loading
          }
        />
        <div className="flex flex-col gap-2">
          <ModelSelect
            name="baseBranch"
            label={FORM_COPY.baseBranch}
            value={baseBranch}
            options={branchOptions}
            onChange={(name) => {
              setBasePick(name);
              clear("baseBranch");
            }}
            error={errors.baseBranch}
            disabled={branchList === undefined}
            placeholder={
              branches.state === "loading"
                ? FORM_COPY.loading
                : FORM_COPY.baseBranchPlaceholder
            }
          />
          {branches.state === "failed" ? (
            <LoadFailure
              sentence={describeImplementerFailure(product, {
                code: branches.failure.code,
                status: branches.failure.status,
              })}
              onRetry={reloadBranches}
            />
          ) : null}
          {branchList?.truncated === true ? (
            <p className="text-sm text-muted-foreground">
              {FORM_COPY.branchesTruncated}
            </p>
          ) : null}
        </div>
        <FormField
          name="branch"
          label={FORM_COPY.newBranch}
          hint={FORM_COPY.newBranchHint}
          error={errors.branch}
        >
          {(control) => (
            <Input
              {...control}
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={branch}
              onChange={(event) => {
                setBranchEdit(event.target.value);
                clear("branch");
              }}
              onBlur={checkBranch}
            />
          )}
        </FormField>
        <FormField
          name="instruction"
          label={FORM_COPY.task}
          error={errors.instruction}
          aside={
            <span
              className={
                instruction.length > INSTRUCTION_MAX_LENGTH
                  ? "text-sm text-destructive"
                  : "text-sm text-muted-foreground"
              }
            >
              {`${instruction.length.toLocaleString("en-US")} / ${INSTRUCTION_MAX_LENGTH.toLocaleString("en-US")}`}
            </span>
          }
        >
          {(control) => (
            <Textarea
              {...control}
              rows={8}
              placeholder={FORM_COPY.taskPlaceholder}
              value={instruction}
              onChange={(event) => {
                setInstruction(event.target.value);
                clear("instruction");
              }}
            />
          )}
        </FormField>
        <ModelPicker
          workspaceSlug={workspaceSlug}
          options={modelOptions}
          pick={modelPick}
          error={errors.model}
          loading={models.state === "loading"}
          onPick={(next) => {
            setModelPick(next);
            clear("model");
          }}
        />
        {models.state === "failed" ? (
          <LoadFailure
            sentence={describeImplementerFailure(product, {
              code: models.failure.code,
              status: models.failure.status,
            })}
            onRetry={reloadModels}
          />
        ) : null}
        <FormField
          name="cost"
          label={FORM_COPY.costLimit}
          hint={FORM_COPY.costLimitHint}
          error={errors.cost}
        >
          {(control) => (
            <Input
              {...control}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              placeholder={costLimitPlaceholder(operatorMaximumCents)}
              value={cost}
              onChange={(event) => {
                setCost(event.target.value);
                clear("cost");
              }}
            />
          )}
        </FormField>
      </fieldset>
      {formError !== null ? (
        <Alert variant="destructive">{formError}</Alert>
      ) : null}
      <div>
        <Button
          type="submit"
          disabled={!canSend}
          loading={pending}
          loadingLabel={FORM_COPY.starting}
        >
          {FORM_COPY.start}
        </Button>
      </div>
    </form>
  );
}

/** A load that failed: its sentence, and a way to ask again. The button sits beside the alert, not in it. */
function LoadFailure({
  sentence,
  onRetry,
}: {
  sentence: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-3">
      <Alert variant="destructive">{sentence}</Alert>
      <Button variant="secondary" onClick={onRetry}>
        {FORM_COPY.tryAgain}
      </Button>
    </div>
  );
}
