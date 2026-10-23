// SPDX-License-Identifier: Apache-2.0

"use client";
// The key mode card with the settings of the own key below it (#656): the key forms are shown while "Use my own provider
// key" is selected and hidden while "Use our models" is, so a workspace on our models sees nothing of keys or providers. The
// selection counts before it is saved, so the key can be entered before the choice is saved.
import { useState, type ReactNode } from "react";
import type { KeyMode } from "../../workspaces/entitlements.ts";
import type { LlmKeyModeApi } from "./key-mode-api.ts";
import { KeyModeCard } from "./key-mode-card.tsx";

export function KeyModeGate({
  workspaceSlug,
  canManage,
  keyMode,
  hasOwnKey,
  api,
  children,
}: {
  workspaceSlug: string;
  canManage: boolean;
  keyMode: KeyMode;
  hasOwnKey: boolean;
  /** Only tests pass this. */
  api?: LlmKeyModeApi;
  /** The own-key settings: the key forms or the key states, and the catalog providers. */
  children: ReactNode;
}) {
  const [selected, setSelected] = useState<KeyMode>(keyMode);
  return (
    <>
      <KeyModeCard
        workspaceSlug={workspaceSlug}
        canManage={canManage}
        keyMode={keyMode}
        hasOwnKey={hasOwnKey}
        onSelect={setSelected}
        {...(api === undefined ? {} : { api })}
      />
      {selected === "own" ? children : null}
    </>
  );
}
