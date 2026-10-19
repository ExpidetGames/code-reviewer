// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { DEFAULT_MODELS_DEV_URL, loadModelsDevSettings } from "./settings.ts";

describe("the settings of the models.dev fetch", () => {
  // #548-T13
  it("fetches the public catalog by default", () => {
    expect(loadModelsDevSettings({})).toEqual({
      enabled: true,
      url: DEFAULT_MODELS_DEV_URL,
      warnings: [],
    });
    expect(DEFAULT_MODELS_DEV_URL).toBe("https://models.dev/api.json");
  });

  // #548-T13
  it.each(["off", "OFF", " off ", "false", "0", "no"])(
    "is switched off by MODELS_DEV_FETCH=%j",
    (value) => {
      expect(loadModelsDevSettings({ MODELS_DEV_FETCH: value }).enabled).toBe(
        false,
      );
    },
  );

  // #548-T13
  it.each(["on", "true", "1", "", "something else"])(
    "stays on for MODELS_DEV_FETCH=%j",
    (value) => {
      expect(loadModelsDevSettings({ MODELS_DEV_FETCH: value }).enabled).toBe(
        true,
      );
    },
  );

  // #548-T13
  it("takes a mirror address, for an instance that cannot reach models.dev", () => {
    expect(
      loadModelsDevSettings({ MODELS_DEV_URL: "https://mirror.corp.example/models/api.json" }),
    ).toMatchObject({ url: "https://mirror.corp.example/models/api.json", warnings: [] });
    expect(
      loadModelsDevSettings({ MODELS_DEV_URL: "http://127.0.0.1:8123/api.json" }).url,
    ).toBe("http://127.0.0.1:8123/api.json");
  });

  // #548-T13
  it.each(["not a url", "ftp://models.dev/api.json", "file:///etc/passwd", "https://user:pw@models.dev/api.json"])(
    "keeps the default and says so for the address %j",
    (value) => {
      expect(loadModelsDevSettings({ MODELS_DEV_URL: value })).toEqual({
        enabled: true,
        url: DEFAULT_MODELS_DEV_URL,
        warnings: ["MODELS_DEV_URL_INVALID"],
      });
    },
  );
});
