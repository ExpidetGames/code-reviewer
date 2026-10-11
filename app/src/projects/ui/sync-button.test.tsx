// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the "Sync from GitHub" button: it runs the sync, says how many repositories are new in a
// sentence, translates the problems GitHub reported instead of showing codes, and refreshes the list.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigation.refresh }),
}));

import type { ProjectsApi } from "./api.ts";
import { SyncButton } from "./sync-button.tsx";

afterEach(cleanup);

function renderButton(result: Awaited<ReturnType<ProjectsApi["sync"]>>) {
  const sync = vi.fn<ProjectsApi["sync"]>(async () => result);
  render(<SyncButton api={{ setActive: vi.fn(), sync }} />);
  return sync;
}

describe("the sync button", () => {
  // CR-21-T03
  it("names the number of new repositories and refreshes the list", async () => {
    const user = userEvent.setup();
    const sync = renderButton({ ok: true, data: { added: 2, errors: [] } });

    await user.click(screen.getByRole("button", { name: "Sync from GitHub" }));

    expect((await screen.findByRole("status")).textContent).toBe(
      "2 new repositories.",
    );
    expect(sync).toHaveBeenCalledTimes(1);
    expect(navigation.refresh).toHaveBeenCalledTimes(1);
  });

  it("says so when nothing is new, and uses the singular for one", async () => {
    const user = userEvent.setup();
    renderButton({ ok: true, data: { added: 1, errors: [] } });

    await user.click(screen.getByRole("button"));

    expect((await screen.findByRole("status")).textContent).toBe(
      "1 new repository.",
    );
  });

  it("translates the problems GitHub reported and shows each sentence once", async () => {
    const user = userEvent.setup();
    const problem = (integrationId: string) => ({
      stage: "repositories" as const,
      integrationId,
      code: "GITHUB_APP_UNAVAILABLE",
      message: "GET /installation/repositories answered 503",
    });
    renderButton({
      ok: true,
      data: { added: 0, errors: [problem("i1"), problem("i2")] },
    });

    await user.click(screen.getByRole("button"));

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("No new repositories.");
    expect(status.textContent).toContain(
      "GitHub could not be reached or had a problem.",
    );
    expect(status.textContent).not.toContain("GITHUB_APP_UNAVAILABLE");
    expect(status.textContent).not.toContain("503");
    expect(status.textContent?.match(/could not be reached/g)).toHaveLength(1);
  });

  it("shows a sentence when the call itself fails", async () => {
    const user = userEvent.setup();
    renderButton({ ok: false, status: 403, code: "ACCESS_DENIED", issues: [] });

    await user.click(screen.getByRole("button"));

    expect((await screen.findByRole("status")).textContent).toMatch(
      /not allowed/i,
    );
    expect(navigation.refresh).not.toHaveBeenCalled();
  });
});
