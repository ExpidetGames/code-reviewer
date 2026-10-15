// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createVercelService } from "./vercel-service.ts";
import type { SandboxSdk } from "./vercel-service.ts";

type Call = { method: string; args: unknown[] };

// A stand-in for the part of the @vercel/sandbox SDK the adapter uses. It records every call and answers
// with the shapes the SDK documents. No request leaves the process.
function stubSdk(options: { listed?: Array<Record<string, unknown>> } = {}) {
  const calls: Call[] = [];
  const record = (method: string, ...args: unknown[]) =>
    calls.push({ method, args });
  const handle = {
    name: "vm-1",
    runCommand: async (params: Record<string, unknown>) => {
      record("runCommand", params);
      const out = params.stdout as { write(chunk: string): void };
      const err = params.stderr as { write(chunk: string): void };
      out.write("hello ");
      out.write("out");
      err.write("warn");
      return { exitCode: 7 };
    },
    writeFiles: async (files: unknown) => {
      record("writeFiles", files);
    },
    snapshot: async (params: unknown) => {
      record("snapshot", params);
      return {
        snapshotId: "snap_1",
        status: "created" as const,
        regions: ["fra1"],
        sizeBytes: 5,
      };
    },
    delete: async (params: unknown) => {
      record("delete", params);
    },
  };
  const sdk: SandboxSdk = {
    Sandbox: {
      create: async (params) => {
        record("create", params);
        return handle;
      },
      get: async (params) => {
        record("get", params);
        return handle;
      },
      list: async (params) => {
        record("list", params);
        return (async function* () {
          for (const item of options.listed ?? []) yield item;
        })() as never;
      },
    },
  };
  return { sdk, calls, handle };
}

describe("the Vercel Sandbox adapter", () => {
  it("creates a VM with the options of the port and the credentials it was given", async () => {
    const { sdk, calls } = stubSdk();
    const service = createVercelService(sdk, {
      token: "t",
      teamId: "team",
      projectId: "prj",
    });
    await service.createVm({
      name: "n",
      region: "fra1",
      vcpus: 2,
      timeoutMs: 1000,
      tags: { app: "x" },
      persistent: false,
      source: { type: "snapshot", snapshotId: "snap_9" },
    });
    expect(calls[0]).toEqual({
      method: "create",
      args: [
        {
          token: "t",
          teamId: "team",
          projectId: "prj",
          name: "n",
          region: "fra1",
          resources: { vcpus: 2 },
          timeout: 1000,
          tags: { app: "x" },
          persistent: false,
          source: { type: "snapshot", snapshotId: "snap_9" },
        },
      ],
    });
  });

  it("passes no credentials when none are given, so the SDK uses the OIDC token of the environment", async () => {
    const { sdk, calls } = stubSdk();
    await createVercelService(sdk).createVm({
      name: "n",
      region: "fra1",
      vcpus: 1,
      timeoutMs: 1,
      tags: {},
      persistent: true,
    });
    expect(Object.keys(calls[0]?.args[0] as object)).not.toContain("token");
    expect((calls[0]?.args[0] as { persistent: boolean }).persistent).toBe(
      true,
    );
    expect(calls[0]?.args[0]).not.toHaveProperty("source");
  });

  it("runs a script with bash -c and returns the exit code and the collected output", async () => {
    const { sdk, calls } = stubSdk();
    const vm = await createVercelService(sdk).createVm({
      name: "n",
      region: "fra1",
      vcpus: 1,
      timeoutMs: 1,
      tags: {},
      persistent: true,
    });
    const result = await vm.run({
      label: "x",
      script: "echo hi",
      sudo: true,
      timeoutMs: 5000,
      env: { A: "b" },
    });
    expect(result).toEqual({
      exitCode: 7,
      stdout: "hello out",
      stderr: "warn",
    });
    const params = calls.find((call) => call.method === "runCommand")
      ?.args[0] as Record<string, unknown>;
    expect(params).toMatchObject({
      cmd: "bash",
      args: ["-c", "echo hi"],
      sudo: true,
      timeoutMs: 5000,
      env: { A: "b" },
    });
  });

  it("writes files, snapshots with an expiry of 0 for none, and deletes with or without the snapshots", async () => {
    const { sdk, calls } = stubSdk();
    const vm = await createVercelService(sdk).createVm({
      name: "n",
      region: "fra1",
      vcpus: 1,
      timeoutMs: 1,
      tags: {},
      persistent: true,
    });
    await vm.writeFile("/tmp/a", "text");
    const info = await vm.snapshot({ expirationMs: 0 });
    await vm.destroy({ deleteSnapshots: true });
    await vm.destroy({ deleteSnapshots: false });
    expect(info).toEqual({
      snapshotId: "snap_1",
      status: "created",
      regions: ["fra1"],
      sizeBytes: 5,
    });
    expect(
      calls
        .filter((call) => call.method !== "create")
        .map((call) => [call.method, call.args[0]]),
    ).toEqual([
      ["writeFiles", [{ path: "/tmp/a", content: "text" }]],
      ["snapshot", { expiration: 0 }],
      ["delete", { deleteOrphanSnapshots: true }],
      ["delete", { deleteOrphanSnapshots: false }],
    ]);
  });

  it("lists the builders by name prefix with their snapshot, and deletes one with its snapshots", async () => {
    const { sdk, calls } = stubSdk({
      listed: [
        { name: "b-1", createdAt: 10, currentSnapshotId: "snap_a" },
        { name: "b-2", createdAt: 20 },
      ],
    });
    const service = createVercelService(sdk, {
      token: "t",
      teamId: "team",
      projectId: "prj",
    });
    expect(await service.listBuilders("b-")).toEqual([
      { name: "b-1", createdAt: 10, snapshotId: "snap_a" },
      { name: "b-2", createdAt: 20 },
    ]);
    expect(calls[0]).toEqual({
      method: "list",
      args: [
        { token: "t", teamId: "team", projectId: "prj", namePrefix: "b-" },
      ],
    });
    await service.deleteBuilder("b-1");
    expect(calls.find((call) => call.method === "get")?.args[0]).toMatchObject({
      name: "b-1",
    });
    expect(calls.find((call) => call.method === "delete")?.args[0]).toEqual({
      deleteOrphanSnapshots: true,
    });
  });
});
