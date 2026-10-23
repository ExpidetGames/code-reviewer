// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// The Connections page with real data: the connections, the repository counts and the requests come from a real
// SQLite file filled by the binding against the fake GitHub; the notice and the list of installations come from
// the query the flow ended with; a Member sees the connections and none of the controls or requests.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

import { createInstallationLinkRequestsRepository } from "../../db/repositories/installation-link-requests-repository.ts";
import { createIntegrationsRepository } from "../../db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../../db/repositories/repositories-repository.ts";
import { createBindingHarness } from "../../test-support/binding-harness.ts";
import {
  ConnectionsPageContent,
  loadConnectionsPage,
} from "./connections-page.tsx";

afterEach(cleanup);

const ACME = { login: "acme", id: 5001, type: "Organization" } as const;

async function openPage(
  options: {
    canManage?: boolean;
    query?: { github?: unknown; picker?: unknown };
    setup?: (
      h: Awaited<ReturnType<typeof createBindingHarness>>,
    ) => Promise<void>;
    userAuthorization?: boolean;
  } = {},
) {
  const h = await createBindingHarness({
    tenancy: "multi",
    ...(options.userAuthorization === undefined
      ? {}
      : { userAuthorization: options.userAuthorization }),
  });
  const a = await h.workspace("a");
  const owner = await h.person("owner-a", { workspaceId: a.id, role: "owner" });
  h.githubUser(1001, "octo");
  h.github.addOrgMember("acme", "octo", "active", "admin");
  h.install({ id: 4242, account: ACME }, ["acme/widgets", "acme/gadgets"]);
  await options.setup?.(h);
  const canManage = options.canManage ?? true;
  const data = await loadConnectionsPage({
    canManage,
    workspaceId: a.id,
    integrations: createIntegrationsRepository(h.db, a.id),
    repositories: createRepositoriesRepository(h.db, a.id),
    linkRequests: createInstallationLinkRequestsRepository(h.db, a.id),
    service: h.binding.service,
    query: options.query ?? {},
    actor: owner,
  });
  render(
    <ConnectionsPageContent
      workspaceSlug="a"
      canManage={canManage}
      data={data}
    />,
  );
  return { h, a, owner, data };
}

describe("the Connections page", () => {
  // #103-IB-02
  it("lists a connection with its account and the number of its repositories, and offers Connect GitHub", async () => {
    await openPage({
      setup: async (h) => {
        const owner = await h.person("owner-a");
        const [workspace] = await h.workspaces.listForUser(owner.id);
        await h.walk(owner, workspace!.workspace.id, {
          installationId: 4242,
          githubLogin: "octo",
        });
      },
    });

    const list = screen.getByRole("list", { name: "Installations" });
    expect(list.textContent).toContain("acme");
    expect(list.textContent).toContain("2 repositories");
    expect(list.textContent).toContain("Connected");
    expect(screen.getByRole("button", { name: "Connect GitHub" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Link an existing installation" }),
    ).toBeTruthy();
  });

  // #638-T02
  it("shows the avatar of the installation's account, built from the account id GitHub gave", async () => {
    const { data } = await openPage({
      setup: async (h) => {
        const owner = await h.person("owner-a");
        const [workspace] = await h.workspaces.listForUser(owner.id);
        await h.walk(owner, workspace!.workspace.id, {
          installationId: 4242,
          githubLogin: "octo",
        });
      },
    });

    expect(data.connections.map((c) => c.avatarUrl)).toEqual([
      "https://avatars.githubusercontent.com/u/5001?v=4",
    ]);
    const row = screen
      .getByRole("list", { name: "Installations" })
      .querySelector("li");
    expect(row?.querySelector("img")?.getAttribute("src")).toBe(
      "https://avatars.githubusercontent.com/u/5001?v=4",
    );
  });

  // #103-IB-15
  it("shows a Member the connections without any control", async () => {
    await openPage({
      canManage: false,
      setup: async (h) => {
        const owner = await h.person("owner-a");
        const [workspace] = await h.workspaces.listForUser(owner.id);
        await h.walk(owner, workspace!.workspace.id, {
          installationId: 4242,
          githubLogin: "octo",
        });
      },
    });

    expect(screen.getByRole("list", { name: "Installations" })).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(
      screen.queryByRole("list", { name: "Requests for the instance admin" }),
    ).toBeNull();
  });

  // #103-IB-22
  it("explains why Connect GitHub is not available while the user authorization is not configured, in a multi-tenant instance", async () => {
    await openPage({ userAuthorization: false });

    expect(
      (
        screen.getByRole("button", {
          name: "Connect GitHub",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByRole("note").textContent).toMatch(
      /Connecting GitHub is not available yet/,
    );
  });

  // #103-IB-19
  it("shows a request that waits and its decision", async () => {
    const { h, data } = await openPage({
      setup: async (h) => {
        h.github.setAppAccountPermissions({ emails: "read" });
        const owner = await h.person("owner-a");
        const [workspace] = await h.workspaces.listForUser(owner.id);
        await h.walk(owner, workspace!.workspace.id, {
          installationId: 4242,
          githubLogin: "octo",
        });
      },
    });

    expect(data.requests).toHaveLength(1);
    expect(
      screen.getByRole("list", { name: "Requests for the instance admin" })
        .textContent,
    ).toMatch(/acme.*Waiting for the admin of the instance/);
    expect(await h.requests.listPending()).toHaveLength(1);
  });

  // #103-IB-10
  it("shows what the flow ended with and the list of installations to choose from", async () => {
    let picker = "";
    await openPage({
      setup: async (h) => {
        const owner = await h.person("owner-a");
        const [workspace] = await h.workspaces.listForUser(owner.id);
        const start = await h.binding.service.startPicker(
          owner,
          workspace!.workspace.id,
        );
        if (!start.ok) throw new Error("no list");
        const listed = await h.authorize(owner, start.url, "octo");
        if (listed.kind !== "done" || listed.picker === undefined)
          throw new Error("no list");
        picker = listed.picker;
      },
      query: {
        get github() {
          return "picker_ready";
        },
        get picker() {
          return picker;
        },
      },
    });

    expect(
      screen.getByText("Choose the installation to connect."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Link acme" })).toBeTruthy();
  });

  // #103-IB-16
  it("shows nothing for a code that is not on its list, and no list for a value that is not a signed list", async () => {
    const { data } = await openPage({
      query: { github: "<script>alert(1)</script>", picker: "forged.value" },
    });

    expect(data.notice).toBeNull();
    expect(data.choices).toBeNull();
    expect(document.querySelector("script")).toBeNull();
  });
});
