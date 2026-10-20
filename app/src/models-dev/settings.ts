// SPDX-License-Identifier: Apache-2.0

// The settings of the daily models.dev fetch (#548), read from the environment on every run, the one place that knows
// the variable names. Never fails: a value that cannot be used keeps the default and is reported as a warning.
//
// | Variable            | Meaning                                                                                       |
// | ------------------- | --------------------------------------------------------------------------------------------- |
// | MODELS_DEV_URL      | Where the catalog is fetched from (default `https://models.dev/api.json`): a mirror for an     |
// |                     | instance that cannot reach it. `http` or `https`; operator configuration, not upstream data.   |
// | MODELS_DEV_FETCH    | `off` (also `false`, `0`, `no`) switches the fetch off for an air-gapped instance: no call, no |
// |                     | row, nothing changes, as with an empty catalog. Anything else leaves it on.                    |

type Env = Readonly<Record<string, string | undefined>>;

export const DEFAULT_MODELS_DEV_URL = "https://models.dev/api.json";
export const MODELS_DEV_SETTING_WARNINGS = ["MODELS_DEV_URL_INVALID"] as const;
export type ModelsDevSettingWarning =
  (typeof MODELS_DEV_SETTING_WARNINGS)[number];

export type ModelsDevSettings = {
  enabled: boolean;
  url: string;
  warnings: ModelsDevSettingWarning[];
};

const OFF = new Set(["off", "false", "0", "no"]);

function usableUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

export function loadModelsDevSettings(env: Env): ModelsDevSettings {
  const enabled = !OFF.has(env.MODELS_DEV_FETCH?.trim().toLowerCase() ?? "");
  const configured = env.MODELS_DEV_URL?.trim();
  if (configured === undefined || configured === "")
    return { enabled, url: DEFAULT_MODELS_DEV_URL, warnings: [] };
  if (!usableUrl(configured))
    return {
      enabled,
      url: DEFAULT_MODELS_DEV_URL,
      warnings: ["MODELS_DEV_URL_INVALID"],
    };
  return { enabled, url: configured, warnings: [] };
}
