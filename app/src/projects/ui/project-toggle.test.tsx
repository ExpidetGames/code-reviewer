// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the switch of a project: pressing it calls the project route with the other state, shows
// the new state and refreshes the page data; a refusal is shown as a sentence and the switch goes
// back; while the call runs it cannot be pressed twice.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigation.refresh }),
}));

import type { ProjectsApi } from "./api.ts";
import { ProjectToggle } from "./project-toggle.tsx";

afterEach(cleanup);

function fakeApi(result: Awaited<ReturnType<ProjectsApi["setActive"]>>) {
  const setActive = vi.fn<ProjectsApi["setActive"]>(async () => result);
  const api: ProjectsApi = {
    setActive,
    sync: vi.fn<ProjectsApi["sync"]>(),
  };
  return { api, setActive };
}

function ok(active: boolean) {
  return {
    ok: true,
    data: { repositoryId: "repo-1", projectId: "p1", active, changed: true },
  } as const;
}

function renderToggle(
  api: ProjectsApi,
  props: { checked?: boolean; blockedReason?: string | null } = {},
) {
  return render(
    <ProjectToggle
      repositoryId="repo-1"
      fullName="acme/widgets"
      checked={props.checked ?? false}
      blockedReason={props.blockedReason ?? null}
      api={api}
    />,
  );
}

describe("switching a project", () => {
  // CR-34-T04
  it("asks the route to activate, shows the switch on and refreshes the page data", async () => {
    const user = userEvent.setup();
    const { api, setActive } = fakeApi(ok(true));
    renderToggle(api);

    await user.click(
      screen.getByRole("switch", { name: "Review acme/widgets" }),
    );

    expect(setActive).toHaveBeenCalledWith("repo-1", true);
    await waitFor(() =>
      expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
        "true",
      ),
    );
    expect(navigation.refresh).toHaveBeenCalledTimes(1);
  });

  // CR-34-T04
  it("asks the route to deactivate a project that is on", async () => {
    const user = userEvent.setup();
    const { api, setActive } = fakeApi(ok(false));
    renderToggle(api, { checked: true });

    await user.click(screen.getByRole("switch"));

    expect(setActive).toHaveBeenCalledWith("repo-1", false);
    await waitFor(() =>
      expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
        "false",
      ),
    );
  });

  // CR-34-T04
  it("shows a sentence for a refusal, keeps the switch where it was and does not refresh", async () => {
    const user = userEvent.setup();
    const { api } = fakeApi({
      ok: false,
      status: 409,
      code: "PROJECT_REPOSITORY_UNAVAILABLE",
      issues: [],
    });
    renderToggle(api);

    await user.click(screen.getByRole("switch"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/no longer available/i);
    expect(alert.textContent).not.toContain("PROJECT_REPOSITORY_UNAVAILABLE");
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(navigation.refresh).not.toHaveBeenCalled();
  });

  it("tells a person whose session ended to sign in again", async () => {
    const user = userEvent.setup();
    const { api } = fakeApi({
      ok: false,
      status: 401,
      code: "UNAUTHENTICATED",
      issues: [],
    });
    renderToggle(api);

    await user.click(screen.getByRole("switch"));

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /sign in again/i,
    );
  });

  it("cannot be pressed again while the call runs", async () => {
    const user = userEvent.setup();
    let finish: (value: ReturnType<typeof ok>) => void = () => undefined;
    const setActive = vi.fn<ProjectsApi["setActive"]>(
      () => new Promise((resolve) => (finish = resolve)),
    );
    renderToggle({ setActive, sync: vi.fn() });

    await user.click(screen.getByRole("switch"));
    await user.click(screen.getByRole("switch"));

    expect(setActive).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(
      true,
    );
    finish(ok(true));
    await waitFor(() =>
      expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });

  // CR-34-T10
  it("does not call the route while activating is blocked, and shows the reason", async () => {
    const user = userEvent.setup();
    const { api, setActive } = fakeApi(ok(true));
    renderToggle(api, { blockedReason: "Configure the GitHub App first." });

    await user.click(screen.getByRole("switch"));

    expect(setActive).not.toHaveBeenCalled();
    expect(screen.getByText("Configure the GitHub App first.")).toBeTruthy();
  });
});
