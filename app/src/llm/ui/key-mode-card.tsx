// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The choice of the key mode while billing is on (ADR 0006, P3, D4; #496): "Use our models" or "Use my own provider key", each with one
// sentence about what is charged. An Owner or an Admin saves it; a Member sees it read-only. The own key needs a stored key (the
// server refuses otherwise, and the option says so). The own-key settings below follow the choice (#656): they are shown while "Use my own
// provider key" is selected, so the key can be saved first, and hidden while "Use our models" is.
import { useProductIdentity } from "../../product-identity/context.tsx";
import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../../components/button.tsx";
import { StatusRegion } from "../../components/status-region.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import { FieldError, FieldLabel } from "../../components/ui/field.tsx";
import {
  RadioGroup,
  RadioGroupItem,
} from "../../components/ui/radio-group.tsx";
import type { KeyMode } from "../../workspaces/entitlements.ts";
import { browserLlmKeyModeApi, type LlmKeyModeApi } from "./key-mode-api.ts";
import {
  CHOICE_SAVED,
  describeKeyModeFailure,
  KEY_MODE_HEADING,
  KEY_MODE_INTRO,
  MANAGED_KEY_UNUSED_NOTE,
  MANAGED_LABEL,
  MANAGED_TEXT,
  OWN_KEY_FIRST_HINT,
  OWN_LABEL,
  OWN_TEXT,
  READ_ONLY_NOTE,
  SAVE_CHOICE_BUTTON,
  SAVE_CHOICE_LOADING,
} from "./key-mode-messages.ts";

const OPTIONS = [
  { mode: "managed", label: MANAGED_LABEL, text: MANAGED_TEXT },
  { mode: "own", label: OWN_LABEL, text: OWN_TEXT },
] as const satisfies ReadonlyArray<{
  mode: KeyMode;
  label: string;
  text: string;
}>;

export function KeyModeCard({
  workspaceSlug,
  canManage,
  keyMode,
  hasOwnKey,
  onSelect,
  api = browserLlmKeyModeApi(workspaceSlug),
}: {
  workspaceSlug: string;
  /** An Admin or an Owner of the workspace (`manage_llm_key`). */
  canManage: boolean;
  /** What applies now: the choice of the workspace, our models until it chose. */
  keyMode: KeyMode;
  /** A key of the workspace's own is stored for some provider. */
  hasOwnKey: boolean;
  /** Called with the option that is selected (saved or not), so the page can show what belongs to it. */
  onSelect?: (keyMode: KeyMode) => void;
  /** Only tests pass this: a function cannot cross from the server component that renders the card, so the card makes its own. */
  api?: LlmKeyModeApi;
}) {
  const product = useProductIdentity();
  const id = useId();
  const router = useRouter();
  const [selected, setSelected] = useState<KeyMode>(keyMode);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function save() {
    setPending(true);
    setSaved(false);
    setProblem(null);
    const result = await api.set(selected);
    setPending(false);
    if (!result.ok) {
      setProblem(describeKeyModeFailure(product, result.code));
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <Card role="region" aria-labelledby={id}>
      <CardHeader>
        <CardTitle>
          <h2
            id={id}
            className="text-lg leading-7 font-semibold tracking-normal"
          >
            {KEY_MODE_HEADING}
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">{KEY_MODE_INTRO}</p>
        <RadioGroup
          value={selected}
          onValueChange={(value) => {
            setSelected(value as KeyMode);
            onSelect?.(value as KeyMode);
            setSaved(false);
            setProblem(null);
          }}
          aria-labelledby={id}
          className="flex flex-col gap-3"
        >
          {OPTIONS.map(({ mode, label, text }) => {
            // The own key can be selected to reach the key form; saving the choice needs a stored key.
            const needsKey = mode === "own" && selected === "own" && !hasOwnKey;
            return (
              <div key={mode} className="flex items-start gap-3">
                <RadioGroupItem
                  value={mode}
                  id={`${id}-${mode}`}
                  disabled={!canManage}
                  className="mt-1"
                />
                <FieldLabel
                  htmlFor={`${id}-${mode}`}
                  className="flex flex-col items-start gap-0.5"
                >
                  <span className="font-semibold">{label}</span>
                  <span className="text-sm font-normal text-muted-foreground">
                    {text}
                  </span>
                  {needsKey && canManage ? (
                    <span className="text-sm font-normal text-muted-foreground">
                      {OWN_KEY_FIRST_HINT}
                    </span>
                  ) : null}
                </FieldLabel>
              </div>
            );
          })}
        </RadioGroup>
        {selected === "managed" || keyMode === "managed" ? (
          <p className="text-sm text-muted-foreground">
            {MANAGED_KEY_UNUSED_NOTE}
          </p>
        ) : null}
        {canManage ? (
          <>
            {problem === null ? null : <FieldError>{problem}</FieldError>}
            <div>
              <Button
                type="button"
                variant="secondary"
                disabled={
                  selected === keyMode || (selected === "own" && !hasOwnKey)
                }
                loading={pending}
                loadingLabel={SAVE_CHOICE_LOADING}
                onClick={() => void save()}
              >
                {SAVE_CHOICE_BUTTON}
              </Button>
            </div>
            <StatusRegion>
              {saved ? (
                <Alert variant="success" role="note">
                  <AlertDescription>{CHOICE_SAVED}</AlertDescription>
                </Alert>
              ) : null}
            </StatusRegion>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{READ_ONLY_NOTE}</p>
        )}
      </CardContent>
    </Card>
  );
}
