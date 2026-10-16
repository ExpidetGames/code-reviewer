// SPDX-License-Identifier: Apache-2.0

// The "Review defaults" sub-page of the workspace settings (#178): the form for the global defaults
// every project inherits (reusing the settings form of #174 in its global mode, where there is no
// project reset; the destructive reset lives in "Advanced"). `loadGlobalSettingsPage` gathers the
// data from the service (passed in), `GlobalSettingsPageContent` renders it.
import type { ReviewSettingsService } from "../service.ts";
import type { SettingsApi } from "./api.ts";
import { SettingsScreen } from "../../workspaces/ui/settings-shell.tsx";
import { modelFromGlobalView, type SettingsFormModel } from "./form-model.ts";
import { SettingsForm } from "./settings-form.tsx";

export type GlobalSettingsPageData = {
  model: SettingsFormModel;
};

export async function loadGlobalSettingsPage(deps: {
  settings: Pick<ReviewSettingsService, "getGlobalSettings">;
}): Promise<GlobalSettingsPageData> {
  return {
    model: modelFromGlobalView(await deps.settings.getGlobalSettings()),
  };
}

export function GlobalSettingsPageContent({
  workspaceSlug,
  canEdit = true,
  showPlan = false,
  data,
  api,
}: {
  /** The workspace of the page. */
  workspaceSlug: string;
  /** Whether the person may change the defaults (an Admin or an Owner). */
  canEdit?: boolean;
  /** The workspace has entitlements (#282): the settings navigation lists the Plan page. */
  showPlan?: boolean;
  data: GlobalSettingsPageData;
  api?: SettingsApi;
}) {
  return (
    <SettingsScreen
      workspaceSlug={workspaceSlug}
      current="review-defaults"
      showPlan={showPlan}
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Every project uses these unless it sets a value of its own on its
          settings page.
        </p>
        {/* Keyed on the server data, see project-settings-page.tsx. */}
        <SettingsForm
          key={JSON.stringify(data.model)}
          workspaceSlug={workspaceSlug}
          readOnly={!canEdit}
          initial={data.model}
          {...(api === undefined ? {} : { api })}
        />
      </div>
    </SettingsScreen>
  );
}
