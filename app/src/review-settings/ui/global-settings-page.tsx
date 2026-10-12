// SPDX-License-Identifier: Apache-2.0

// The content of the Settings page: the configuration hints, the state of the instance (GitHub App
// and LLM access) and the form for the global defaults every project inherits. `loadGlobalSettingsPage`
// gathers the data from the service (passed in), `GlobalSettingsPageContent` renders it.
import { ConfigNotices } from "../../config-status/notices.tsx";
import { InstanceStatus } from "../../config-status/instance-status.tsx";
import type {
  ConfigAudience,
  ConfigStatus,
} from "../../config-status/status.ts";
import type { ReviewSettingsService } from "../service.ts";
import type { SettingsApi } from "./api.ts";
import { modelFromGlobalView, type SettingsFormModel } from "./form-model.ts";
import { SettingsForm } from "./settings-form.tsx";

export type GlobalSettingsPageData = {
  model: SettingsFormModel;
  config: ConfigStatus;
};

export async function loadGlobalSettingsPage(deps: {
  settings: Pick<ReviewSettingsService, "getGlobalSettings">;
  config: () => ConfigStatus | Promise<ConfigStatus>;
}): Promise<GlobalSettingsPageData> {
  return {
    model: modelFromGlobalView(await deps.settings.getGlobalSettings()),
    config: await deps.config(),
  };
}

export function GlobalSettingsPageContent({
  workspaceSlug,
  audience = "member",
  canEdit = true,
  data,
  api,
}: {
  /** The workspace of the page. */
  workspaceSlug: string;
  /** Whether the person runs the instance (reads which variables are wrong) or is a member. */
  audience?: ConfigAudience;
  /** Whether the person may change the defaults (an Admin or an Owner). */
  canEdit?: boolean;
  data: GlobalSettingsPageData;
  api?: SettingsApi;
}) {
  return (
    <>
      <ConfigNotices status={data.config} audience={audience} />
      <section className="settings-section" aria-labelledby="instance-heading">
        <h2 id="instance-heading">Instance</h2>
        <InstanceStatus status={data.config} audience={audience} />
      </section>
      <section className="settings-section" aria-labelledby="defaults-heading">
        <h2 id="defaults-heading">Default review settings</h2>
        <p className="muted">
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
      </section>
    </>
  );
}
