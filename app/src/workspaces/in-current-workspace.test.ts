// The services for "the current workspace" look the workspace up on first use, once.
import { describe, expect, it, vi } from "vitest";
import { inCurrentWorkspace } from "./in-current-workspace.ts";

function setup() {
  const resolve = vi.fn(async () => "workspace-1");
  const build = vi.fn((workspaceId: string) => ({
    async whoAmI(suffix: string) {
      return `${workspaceId}${suffix}`;
    },
  }));
  return { resolve, build, service: inCurrentWorkspace(build, resolve) };
}

describe("a service in the current workspace", () => {
  it("looks the workspace up only when a method is called, so building it reads nothing", () => {
    const { resolve, build } = setup();

    expect(resolve).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  it("builds the real service for the workspace and passes the arguments through", async () => {
    const { resolve, build, service } = setup();

    expect(await service.whoAmI("!")).toBe("workspace-1!");
    expect(await service.whoAmI("?")).toBe("workspace-1?");

    expect(build).toHaveBeenCalledWith("workspace-1");
    expect(build).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("is not mistaken for a promise when something awaits it", async () => {
    const { service } = setup();

    expect(await Promise.resolve(service)).toBe(service);
  });

  it("rejects a call when the workspace cannot be resolved", async () => {
    const service = inCurrentWorkspace(
      () => ({ async ping() {} }),
      async () => {
        throw new Error("no database");
      },
    );

    await expect(service.ping()).rejects.toThrow("no database");
  });
});
