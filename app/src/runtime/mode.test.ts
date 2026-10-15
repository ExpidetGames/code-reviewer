// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  isServerless,
  resolveRuntimeMode,
  RuntimeConfigError,
} from "./mode.ts";

describe("the runtime mode", () => {
  // #319-T06
  it("is server when nothing is set, which keeps the Docker and Coolify path as it is", () => {
    expect(resolveRuntimeMode({})).toBe("server");
    expect(isServerless({})).toBe(false);
  });

  // #319-T01
  it("is serverless when APP_RUNTIME says so, in any letter case", () => {
    expect(resolveRuntimeMode({ APP_RUNTIME: "serverless" })).toBe(
      "serverless",
    );
    expect(resolveRuntimeMode({ APP_RUNTIME: " Serverless " })).toBe(
      "serverless",
    );
  });

  // #319-T01
  it("is serverless on its own when the platform marker is present", () => {
    expect(resolveRuntimeMode({ VERCEL: "1" })).toBe("serverless");
  });

  // #319-T06
  it("lets an explicit APP_RUNTIME win over the platform marker", () => {
    expect(resolveRuntimeMode({ VERCEL: "1", APP_RUNTIME: "server" })).toBe(
      "server",
    );
  });

  // #319-T06
  it("treats an empty APP_RUNTIME as unset", () => {
    expect(resolveRuntimeMode({ APP_RUNTIME: "  " })).toBe("server");
    expect(resolveRuntimeMode({ APP_RUNTIME: "", VERCEL: "1" })).toBe(
      "serverless",
    );
  });

  // #319-T06
  it("ignores a platform marker that is not 1", () => {
    expect(resolveRuntimeMode({ VERCEL: "0" })).toBe("server");
    expect(resolveRuntimeMode({ VERCEL: "true" })).toBe("server");
  });

  // #319-T06
  it("refuses an unknown mode with a stable code and without echoing the value", () => {
    let caught: unknown;
    try {
      resolveRuntimeMode({ APP_RUNTIME: "lambda-secret-xyz" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RuntimeConfigError);
    const error = caught as RuntimeConfigError;
    expect(error.code).toBe("APP_RUNTIME_INVALID");
    expect(error.message).toContain("APP_RUNTIME");
    expect(error.message).not.toContain("lambda-secret-xyz");
  });
});
