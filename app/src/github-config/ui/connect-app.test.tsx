// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins "Connect the App" (#182): the two ways to connect GitHub are alternatives behind one segmented
// control, so only the chosen path renders.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GithubConfigView } from "../service.ts";
import type { GithubApi } from "./api.ts";
import { ConnectApp } from "./connect-app.tsx";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

afterEach(cleanup);

const view: GithubConfigView = {
  status: "not_configured",
  source: "none",
  app: null,
  problem: null,
  secrets: { privateKey: "none", webhookSecret: "none", clientSecret: "none" },
  userAuthorization: { configured: false, clientId: null },
  urls: { homepage: "", webhook: "", callback: "", setup: "" },
  privateAppUnknown: false,
  mayLackPermissions: false,
  updatedAt: null,
};

describe("connecting the App", () => {
  // #182-T02
  it("renders one setup path at a time and switches with the control", async () => {
    const user = userEvent.setup();
    render(
      <ConnectApp
        view={view}
        suggestedName="code-reviewer"
        tenancy="single"
        api={{} as GithubApi}
      />,
    );

    expect(
      screen.getByRole("form", { name: "Create the App with one click" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("form", { name: "Enter the values by hand" }),
    ).toBeNull();

    await user.click(screen.getByRole("tab", { name: "Enter values by hand" }));

    expect(
      screen.getByRole("form", { name: "Enter the values by hand" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("form", { name: "Create the App with one click" }),
    ).toBeNull();
  });
});
