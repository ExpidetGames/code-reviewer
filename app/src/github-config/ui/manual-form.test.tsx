// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins down that the manual form never answers "is this a private App" for the admin: the answer decides
// whether a new installation is attached to the workspace of a single-tenant instance on its own.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GithubConfigView } from "../service.ts";
import type { GithubApi } from "./api.ts";
import { ManualForm } from "./manual-form.tsx";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

afterEach(cleanup);

function view(privateApp: boolean | null): GithubConfigView {
  return {
    status: "not_configured",
    source: "none",
    app:
      privateApp === null
        ? null
        : {
            appId: "1",
            slug: "an-app",
            privateApp,
            origin: "manual",
            installUrl: null,
          },
    problem: null,
    secrets: {
      privateKey: "none",
      webhookSecret: "none",
      clientSecret: "none",
    },
    userAuthorization: { configured: false, clientId: null },
    urls: { homepage: "", webhook: "", callback: "", setup: "" },
    privateAppUnknown: privateApp === null,
    mayLackPermissions: false,
    updatedAt: null,
  };
}

function radio(name: RegExp): HTMLInputElement {
  return screen.getByRole("radio", { name }) as HTMLInputElement;
}

describe("the choice of where the App can be installed", () => {
  // #103 reads the flag for the auto-attach of a single-tenant instance, so there is no default.
  it("has no default and is required", () => {
    render(<ManualForm view={view(null)} api={{} as GithubApi} />);

    const own = radio(/only on its own account/i);
    const any = radio(/on any account/i);

    expect(own.checked).toBe(false);
    expect(any.checked).toBe(false);
    expect(own.required).toBe(true);
    expect(any.required).toBe(true);
  });

  it("shows the stored answer, and a changed answer is sent as chosen", async () => {
    const saveApp = vi.fn(() =>
      Promise.resolve({ ok: true as const, result: { ok: true as const } }),
    );
    render(
      <ManualForm
        view={view(true)}
        api={{ saveApp } as unknown as GithubApi}
      />,
    );
    const user = userEvent.setup();

    expect(radio(/only on its own account/i).checked).toBe(true);
    await user.click(radio(/on any account/i));
    await user.type(screen.getByLabelText("Private key"), "key");
    await user.type(screen.getByLabelText("Webhook secret"), "secret");
    await user.click(screen.getByRole("button", { name: "Save and check" }));

    expect(saveApp).toHaveBeenCalledWith(
      expect.objectContaining({ privateApp: false }),
    );
  });
});
